/* EWS Bridge — privileged experiment API (runs in the parent process).
 *
 * Deliberately small: everything protocol-related lives in the unprivileged
 * background page. This file only provides what WebExtensions cannot do:
 *   - loopback TCP listeners for the IMAP/SMTP/DAV gateway,
 *   - HTTP requests where Gecko performs NTLM / Negotiate / Basic,
 *   - password-manager storage,
 *   - creating the Thunderbird account, calendar and address book entries.
 */

/* global ExtensionCommon, ExtensionAPI, Services, Cc, Ci, Cr, Cu, ChromeUtils */

"use strict";

var { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
var { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
// The experiment global has no web encoding APIs; borrow them from the
// shared module global (distinct names avoid shadowing a hoisted global).
const utf8 = (() => {
  for (const source of [() => globalThis, () => Cu.getGlobalForObject(NetUtil)]) {
    try {
      const g = source();
      return { encoder: new g.TextEncoder(), decoder: new g.TextDecoder("utf-8") };
    } catch {}
  }
  throw new Error("No TextEncoder available");
})();

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "cal", () => ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs").cal);
ChromeUtils.defineLazyGetter(lazy, "CardDAVDirectory", () => ChromeUtils.importESModule("resource:///modules/CardDAVDirectory.sys.mjs").CardDAVDirectory);

const LOCALHOST = "127.0.0.1";

/** Opt-in tracing to stdout: set extensions.ewsbridge.debug = true. */
function trace(msg) {
  if (Services.prefs.getBoolPref("extensions.ewsbridge.debug", false)) {
    dump(`[ews-bridge] ${msg}\n`);
  }
}
const DAV_REALM = "EWS Bridge";
const SECRET_ORIGIN = "ews-bridge://secrets";
const PORTS_PREF = "extensions.ewsbridge.ports";

// --------------------------------------------------------------------------
// Sockets

class Connection {
  constructor(id, transport, emit) {
    this.id = id;
    this.transport = transport;
    this.emit = emit;
    this.pending = [];
    this.waiting = false;
    this.closing = false;
    this.closed = false;
    this.input = transport.openInputStream(0, 0, 0);
    this.output = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
    const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
    pump.init(this.input, 0, 0, false);
    pump.asyncRead({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() {},
      onDataAvailable: (request, stream, offset, count) => {
        const bis = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
        bis.setInputStream(stream);
        this.emit("data", this.id, bis.readBytes(count));
      },
      onStopRequest: () => this.destroy(),
    });
  }

  write(data) {
    if (this.closed) {
      return;
    }
    this.pending.push(data);
    this.flush();
  }

  flush() {
    while (this.pending.length && !this.closed) {
      const chunk = this.pending[0].length > 65536 ? this.pending[0].slice(0, 65536) : this.pending[0];
      let n;
      try {
        n = this.output.write(chunk, chunk.length);
      } catch (e) {
        if (e.result == Cr.NS_BASE_STREAM_WOULD_BLOCK) {
          this.wait();
          return;
        }
        this.destroy();
        return;
      }
      if (n < this.pending[0].length) {
        this.pending[0] = this.pending[0].slice(n);
        if (n < chunk.length) {
          this.wait();
          return;
        }
      } else {
        this.pending.shift();
      }
    }
    if (this.closing && !this.pending.length) {
      this.destroy();
    }
  }

  wait() {
    if (this.waiting) {
      return;
    }
    this.waiting = true;
    this.output.asyncWait(
      {
        QueryInterface: ChromeUtils.generateQI(["nsIOutputStreamCallback"]),
        onOutputStreamReady: () => {
          this.waiting = false;
          this.flush();
        },
      },
      0,
      0,
      Services.tm.mainThread
    );
  }

  close() {
    this.closing = true;
    this.flush();
  }

  destroy() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.output.close();
    } catch {}
    try {
      this.input.close();
    } catch {}
    try {
      this.transport.close(Cr.NS_OK);
    } catch {}
    this.emit("closed", this.id);
  }
}

// --------------------------------------------------------------------------
// HTTP with Gecko authentication

function authPrompt(creds, state) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIAuthPrompt2"]),
    promptAuth(channel, level, authInfo) {
      if (!creds || state.attempts >= 2 || authInfo.flags & Ci.nsIAuthInformation.PREVIOUS_FAILED) {
        state.rejected = true;
        return false;
      }
      state.attempts++;
      let user = creds.username || "";
      let domain = creds.domain || "";
      const m = /^([^\\/]+)[\\/](.+)$/.exec(user);
      if (m) {
        domain = m[1];
        user = m[2];
      }
      if (authInfo.flags & Ci.nsIAuthInformation.NEED_DOMAIN) {
        authInfo.domain = domain;
        authInfo.username = user;
      } else {
        authInfo.username = domain ? `${domain}\\${user}` : user;
      }
      authInfo.password = creds.password || "";
      state.scheme = authInfo.authenticationScheme;
      return true;
    },
    asyncPromptAuth(channel, callback, context, level, authInfo) {
      const ok = this.promptAuth(channel, level, authInfo);
      Services.tm.dispatchToMainThread(() => {
        if (ok) {
          callback.onAuthAvailable(context, authInfo);
        } else {
          callback.onAuthCancelled(context, true);
        }
      });
      return { QueryInterface: ChromeUtils.generateQI(["nsICancelable"]), cancel() {} };
    },
  };
}

function httpRequest(req, creds) {
  return new Promise(resolve => {
    let channel;
    try {
      const uri = Services.io.newURI(req.url);
      if (uri.scheme != "https" && uri.scheme != "http") {
        throw new Error("Only http(s) URLs are supported");
      }
      channel = NetUtil.newChannel({
        uri,
        loadUsingSystemPrincipal: true,
        contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
      }).QueryInterface(Ci.nsIHttpChannel);
    } catch (e) {
      resolve({ error: e.message, errorKind: "network" });
      return;
    }
    const headers = req.headers || {};
    if (req.body !== null && req.body !== undefined) {
      const bytes = utf8.encoder.encode(req.body);
      const stream = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(Ci.nsIArrayBufferInputStream);
      stream.setData(bytes.buffer, 0, bytes.length);
      const type = headers["Content-Type"] || "text/xml; charset=utf-8";
      channel.QueryInterface(Ci.nsIUploadChannel2).explicitSetUploadStream(stream, type, bytes.length, req.method || "POST", false);
    } else {
      channel.requestMethod = req.method || "GET";
    }
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() != "content-type") {
        channel.setRequestHeader(k, String(v), false);
      }
    }
    channel.setRequestHeader("User-Agent", "EWSBridge/1.0 (Thunderbird)", false);
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING | Ci.nsIRequest.LOAD_BACKGROUND;
    if (req.noRedirect) {
      channel.redirectionLimit = 0;
    }
    const state = { attempts: 0, rejected: false, scheme: null };
    const prompt = authPrompt(creds, state);
    channel.notificationCallbacks = {
      QueryInterface: ChromeUtils.generateQI(["nsIInterfaceRequestor"]),
      getInterface(iid) {
        if (iid.equals(Ci.nsIAuthPrompt2)) {
          return prompt;
        }
        throw Components.Exception("", Cr.NS_ERROR_NO_INTERFACE);
      },
    };
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        channel.cancel(Cr.NS_ERROR_NET_TIMEOUT);
      }
    }, req.timeoutMs || 120000);
    channel.asyncOpen({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        const bis = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
        bis.setInputStream(stream);
        chunks.push(new Uint8Array(bis.readByteArray(count)));
      },
      onStopRequest(request, status) {
        done = true;
        clearTimeout(timer);
        let httpStatus = 0;
        const respHeaders = {};
        try {
          httpStatus = channel.responseStatus;
          channel.visitResponseHeaders({
            QueryInterface: ChromeUtils.generateQI(["nsIHttpHeaderVisitor"]),
            visitHeader(name, value) {
              const k = name.toLowerCase();
              respHeaders[k] = respHeaders[k] ? `${respHeaders[k]}, ${value}` : value;
            },
          });
        } catch {}
        if (!Components.isSuccessCode(status) && !httpStatus) {
          let name = "";
          try {
            name = ChromeUtils.getXPCOMErrorName(status);
          } catch {}
          let kind = "network";
          let message = name || `0x${status.toString(16)}`;
          if (/SEC_ERROR|SSL_ERROR|MOZILLA_PKIX|NS_ERROR_GENERATE_FAILURE\(NS_ERROR_MODULE_SECURITY/.test(name) || (status >>> 16 & 0x7fff) == 21) {
            kind = "certificate";
            message = `TLS/certificate problem (${message}). Thunderbird does not trust the server certificate.`;
          } else if (name == "NS_ERROR_UNKNOWN_HOST") {
            message = "Host name not found (DNS). Are you connected to the network or VPN?";
          } else if (name == "NS_ERROR_CONNECTION_REFUSED") {
            message = "Connection refused by the server.";
          } else if (name == "NS_ERROR_NET_TIMEOUT") {
            message = "The server did not respond in time.";
          }
          resolve({ error: message, errorKind: kind });
          return;
        }
        let total = 0;
        chunks.forEach(c => (total += c.length));
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        resolve({
          status: httpStatus,
          headers: respHeaders,
          body: utf8.decoder.decode(all),
          authScheme: state.scheme,
          authRejected: state.rejected,
        });
      },
    });
  });
}

// --------------------------------------------------------------------------
// Password manager helpers

async function findLogins(origin, realm = null) {
  const query = { origin };
  if (realm !== null) {
    query.httpRealm = realm;
  }
  return Services.logins.searchLoginsAsync(query);
}

async function setLogin(origin, realm, username, password) {
  for (const l of await findLogins(origin, realm)) {
    if (l.username == username) {
      await Services.logins.removeLoginAsync(l);
    }
  }
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  login.init(origin, null, realm, username, password, "", "");
  await Services.logins.addLoginAsync(login);
}

async function removeLogins(origin, realm, username) {
  for (const l of await findLogins(origin, realm)) {
    if (username === null || l.username == username) {
      await Services.logins.removeLoginAsync(l);
    }
  }
}

// --------------------------------------------------------------------------
// Thunderbird account wiring

function findOurImapServer(email) {
  for (const s of MailServices.accounts.allServers) {
    if (s.type == "imap" && s.hostname == LOCALHOST && s.username.toLowerCase() == email.toLowerCase()) {
      return s;
    }
  }
  return null;
}

function findOurSmtpServer(email) {
  for (const s of MailServices.outgoingServer.servers) {
    try {
      const smtp = s.QueryInterface(Ci.nsISmtpServer);
      if (smtp.hostname == LOCALHOST && (s.username || "").toLowerCase() == email.toLowerCase()) {
        return s;
      }
    } catch {}
  }
  return null;
}

function davUrl(port, kind, key, id) {
  return `http://${LOCALHOST}:${port}/${kind}/${key}/${id}/`;
}

function ourCalendars(key) {
  return lazy.cal.manager.getCalendars().filter(c => c.type == "caldav" && c.uri.host == LOCALHOST && c.uri.pathQueryRef.startsWith(`/calendars/${key}/`));
}

function ourAddressBooks(key) {
  return MailServices.ab.directories.filter(d => {
    if (d.dirType != Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE) {
      return false; // e.g. provider-backed books have no prefs at all
    }
    try {
      const url = d.getStringValue("carddav.url", "");
      return url.includes(`//${LOCALHOST}:`) && url.includes(`/addressbooks/${key}/`);
    } catch {
      return false;
    }
  });
}

function folderUriForFlag(server, flag) {
  try {
    const f = server.rootFolder.getFolderWithFlags(flag);
    return f ? f.URI : null;
  } catch {
    return null;
  }
}

async function configureAccount(cfg) {
  const { key, email, displayName, localPassword, ports } = cfg;
  const result = { created: [] };

  // Passwords for Thunderbird's own clients talking to the gateway.
  await setLogin(`imap://${LOCALHOST}`, `imap://${LOCALHOST}`, email, localPassword);
  await setLogin(`smtp://${LOCALHOST}`, `smtp://${LOCALHOST}`, email, localPassword);
  await setLogin(`http://${LOCALHOST}:${ports.dav}`, DAV_REALM, email, localPassword);

  // Outgoing (SMTP) server
  let smtp = findOurSmtpServer(email);
  if (!smtp) {
    smtp = MailServices.outgoingServer.createServer("smtp");
    result.created.push("smtp");
  }
  const smtpServer = smtp.QueryInterface(Ci.nsISmtpServer);
  smtpServer.hostname = LOCALHOST;
  smtpServer.port = ports.smtp;
  smtp.socketType = Ci.nsMsgSocketType.plain;
  smtp.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
  smtp.username = email;
  smtp.password = localPassword;
  smtp.description = `Exchange (${email})`;

  // Incoming (IMAP) server + account + identity
  let server = findOurImapServer(email);
  let account;
  if (!server) {
    server = MailServices.accounts.createIncomingServer(email, LOCALHOST, "imap");
    result.created.push("imap");
  } else {
    account = MailServices.accounts.findAccountForServer(server);
  }
  server.port = ports.imap;
  server.socketType = Ci.nsMsgSocketType.plain;
  server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
  server.password = localPassword;
  server.prettyName = displayName && displayName != email ? `${email} (Exchange)` : `${email} (Exchange)`;
  // The gateway knows Exchange's item size, not the exact MIME size, so never
  // fetch messages in chunks (that could truncate them).
  server.setBoolValue("fetch_by_chunks", false);
  server.setBoolValue("use_idle", true);
  server.setBoolValue("login_at_startup", true);
  server.setIntValue("max_cached_connections", 5);
  server.doBiff = true;
  server.biffMinutes = 5;
  if (cfg.trashFolder) {
    server.setStringValue("trash_folder_name", cfg.trashFolder);
  }
  server.valid = true;

  if (!account) {
    const identity = MailServices.accounts.createIdentity();
    identity.fullName = displayName || email;
    identity.email = email;
    identity.smtpServerKey = smtp.key;
    // Exchange stores the sent copy itself (SendAndSaveCopy).
    identity.doFcc = false;
    identity.valid = true;
    account = MailServices.accounts.createAccount();
    account.addIdentity(identity);
    account.incomingServer = server;
    result.created.push("account");
  } else {
    const identity = account.defaultIdentity;
    if (identity) {
      identity.smtpServerKey = smtp.key;
      identity.doFcc = false;
    }
  }
  MailServices.accounts.saveAccountInfo();
  const identity = account.defaultIdentity;

  // Calendars
  const existingCals = ourCalendars(key);
  for (const c of cfg.calendars || []) {
    const url = davUrl(ports.dav, "calendars", key, c.id);
    if (existingCals.some(x => x.uri.spec == url)) {
      continue;
    }
    const calendar = lazy.cal.manager.createCalendar("caldav", Services.io.newURI(url));
    if (!calendar) {
      continue;
    }
    calendar.name = c.primary ? `${c.name} (${email})` : c.name;
    calendar.setProperty("color", c.color || "#0078d4");
    calendar.setProperty("username", email);
    calendar.setProperty("cache.enabled", true);
    calendar.setProperty("calendar-main-in-composite", true);
    if (identity) {
      calendar.setProperty("imip.identity.key", identity.key);
    }
    lazy.cal.manager.registerCalendar(calendar);
    result.created.push(`calendar:${c.id}`);
  }

  // Address books
  const existingBooks = ourAddressBooks(key);
  for (const b of cfg.addressBooks || []) {
    const url = davUrl(ports.dav, "addressbooks", key, b.id);
    if (existingBooks.some(d => d.getStringValue("carddav.url", "") == url)) {
      continue;
    }
    const dirPrefId = MailServices.ab.newAddressBook(b.primary ? `${b.name} (${email})` : b.name, null, Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE, null);
    const book = MailServices.ab.getDirectoryFromId(dirPrefId);
    book.setStringValue("carddav.url", url);
    book.setStringValue("carddav.username", email);
    // The registered directory is the CardDAVDirectory instance itself.
    const dir = book.wrappedJSObject || book;
    Promise.resolve()
      .then(() => dir.fetchAllFromServer())
      .catch(e => console.error("EWS Bridge: initial CardDAV sync failed", e));
    result.created.push(`addressbook:${b.id}`);
  }

  Services.prefs.savePrefFile(null);
  result.accountKey = account.key;
  result.identityKey = identity?.key || null;
  return result;
}

async function updatePorts(cfg) {
  const { key, email, localPassword, ports, oldPorts } = cfg;
  const server = findOurImapServer(email);
  if (server) {
    server.port = ports.imap;
  }
  const smtp = findOurSmtpServer(email);
  if (smtp) {
    smtp.QueryInterface(Ci.nsISmtpServer).port = ports.smtp;
  }
  if (oldPorts?.dav && oldPorts.dav != ports.dav) {
    await removeLogins(`http://${LOCALHOST}:${oldPorts.dav}`, DAV_REALM, email);
    for (const c of ourCalendars(key)) {
      const newUri = c.uri.spec.replace(`:${oldPorts.dav}/`, `:${ports.dav}/`);
      Services.prefs.setStringPref(`calendar.registry.${c.id}.uri`, newUri);
      c.uri = Services.io.newURI(newUri);
    }
    for (const d of ourAddressBooks(key)) {
      d.setStringValue("carddav.url", d.getStringValue("carddav.url", "").replace(`:${oldPorts.dav}/`, `:${ports.dav}/`));
    }
  }
  await setLogin(`http://${LOCALHOST}:${ports.dav}`, DAV_REALM, email, localPassword);
  Services.prefs.savePrefFile(null);
}

function fixIdentityFolders(email) {
  const server = findOurImapServer(email);
  if (!server) {
    return { ok: false };
  }
  const account = MailServices.accounts.findAccountForServer(server);
  const identity = account?.defaultIdentity;
  if (!identity) {
    return { ok: false };
  }
  const F = Ci.nsMsgFolderFlags;
  const drafts = folderUriForFlag(server, F.Drafts);
  const sent = folderUriForFlag(server, F.SentMail);
  const archive = folderUriForFlag(server, F.Archive);
  const changed = [];
  if (drafts && identity.draftsFolderURI != drafts) {
    identity.draftsFolderURI = drafts;
    identity.draftsFolderPickerMode = 1;
    changed.push("drafts");
  }
  if (sent && identity.fccFolderURI != sent) {
    identity.fccFolderURI = sent;
    identity.fccFolderPickerMode = 1;
    changed.push("sent");
  }
  if (archive && identity.archiveFolderURI != archive) {
    identity.archiveFolderURI = archive;
    changed.push("archive");
  }
  return { ok: true, changed };
}

/** Start folder discovery and a new-mail check right away instead of waiting for biff. */
function kickSync(email) {
  const server = findOurImapServer(email);
  trace(`kickSync ${email}: server ${server ? server.key + " port " + server.port : "not found"}; servers: ${MailServices.accounts.allServers.map(x => `${x.key}:${x.type}:${x.hostname}:${x.username}:${x.realUsername}`).join(", ")}`);
  if (!server) {
    return false;
  }
  try {
    server.performExpand(null);
  } catch (e) {
    console.warn("EWS Bridge: folder discovery failed", e);
  }
  setTimeout(() => {
    try {
      server.performBiff(null);
    } catch (e) {
      console.warn("EWS Bridge: mail check failed", e);
    }
  }, 3000);
  return true;
}

async function removeAccount(cfg) {
  const { key, email, ports } = cfg;
  const server = findOurImapServer(email);
  if (server) {
    const account = MailServices.accounts.findAccountForServer(server);
    if (account) {
      MailServices.accounts.removeAccount(account, cfg.removeData !== false);
    }
  }
  const smtp = findOurSmtpServer(email);
  if (smtp) {
    MailServices.outgoingServer.deleteServer(smtp);
  }
  for (const c of ourCalendars(key)) {
    lazy.cal.manager.removeCalendar(c);
  }
  for (const d of ourAddressBooks(key)) {
    MailServices.ab.deleteAddressBook(d.URI);
  }
  await removeLogins(`imap://${LOCALHOST}`, `imap://${LOCALHOST}`, email);
  await removeLogins(`smtp://${LOCALHOST}`, `smtp://${LOCALHOST}`, email);
  if (ports?.dav) {
    await removeLogins(`http://${LOCALHOST}:${ports.dav}`, DAV_REALM, email);
  }
  Services.prefs.savePrefFile(null);
}

// --------------------------------------------------------------------------

this.ewsBridge = class extends ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.servers = new Map();
    this.connections = new Map();
    this.credentials = new Map();
    this.nextId = 1;
    this.listeners = { connection: new Set(), data: new Set(), closed: new Set() };
    this.backlog = []; // events fired before the background registered listeners
    this.prebound = new Map(); // port -> serverId, bound in onStartup
  }

  emit(type, ...args) {
    const set = this.listeners[type];
    trace(`emit ${type} ${args[0]} ${type == "data" ? `${String(args[1]).length} bytes: ${String(args[1]).slice(0, 60).replace(/\r?\n/g, "⏎")}` : ""} (listeners: ${set.size})`);
    if (!set.size) {
      this.backlog.push([type, args]);
      return;
    }
    for (const fire of set) {
      fire.async(...args);
    }
  }

  createServer(port) {
    const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    server.init(port, true, -1);
    const serverId = this.nextId++;
    server.asyncListen({
      QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
      onSocketAccepted: (serv, transport) => {
        const connId = this.nextId++;
        trace(`accepted conn ${connId} on port ${serv.port}`);
        this.emit("connection", serverId, connId);
        const conn = new Connection(connId, transport, (type, id, data) => {
          if (type == "closed") {
            this.connections.delete(id);
          }
          this.emit(type, id, data);
        });
        this.connections.set(connId, conn);
      },
      onStopListening() {},
    });
    this.servers.set(serverId, server);
    trace(`listening on ${LOCALHOST}:${server.port} (server ${serverId})`);
    return { serverId, port: server.port };
  }

  /**
   * Runs when the add-on starts, which is before Thunderbird's startup mail
   * check. Binding the gateway ports now means that check reaches us (and
   * waits for the background page) instead of failing with "connection refused".
   */
  onStartup() {
    let ports = {};
    try {
      ports = JSON.parse(Services.prefs.getStringPref(PORTS_PREF, "{}"));
    } catch {}
    for (const port of Object.values(ports)) {
      if (Number.isInteger(port) && port > 0) {
        try {
          this.prebound.set(port, this.createServer(port).serverId);
        } catch (e) {
          trace(`could not pre-bind port ${port}: ${e.message}`);
        }
      }
    }
  }

  onShutdown() {
    for (const c of this.connections.values()) {
      c.destroy();
    }
    for (const s of this.servers.values()) {
      try {
        s.close();
      } catch {}
    }
    this.connections.clear();
    this.servers.clear();
  }

  getAPI(context) {
    const self = this;
    const makeEvent = (name, type) =>
      new ExtensionCommon.EventManager({
        context,
        name: `ewsBridge.${name}`,
        register(fire) {
          self.listeners[type].add(fire);
          if (self.backlog.length) {
            const pending = self.backlog.filter(([t]) => t == type);
            self.backlog = self.backlog.filter(([t]) => t != type);
            for (const [, args] of pending) {
              fire.async(...args);
            }
          }
          return () => self.listeners[type].delete(fire);
        },
      }).api();

    return {
      ewsBridge: {
        async listen(port) {
          // Ports bound at startup (before Thunderbird's first mail check) are handed over.
          if (port && self.prebound.has(port)) {
            const serverId = self.prebound.get(port);
            self.prebound.delete(port);
            return { serverId, port };
          }
          try {
            return self.createServer(port);
          } catch (e) {
            throw new ExtensionError(`Cannot listen on port ${port}: ${e.message}`);
          }
        },

        async rememberPorts(ports) {
          Services.prefs.setStringPref(PORTS_PREF, JSON.stringify(ports));
        },

        async stopListening(serverId) {
          const s = self.servers.get(serverId);
          if (s) {
            s.close();
            self.servers.delete(serverId);
          }
        },

        async write(connId, data) {
          self.connections.get(connId)?.write(data);
        },

        async closeConnection(connId) {
          self.connections.get(connId)?.close();
        },

        async httpRequest(request) {
          const creds = self.credentials.get(request.accountKey) || null;
          return httpRequest(request, creds);
        },

        async setCredentials(accountKey, credentials) {
          const prev = self.credentials.get(accountKey);
          self.credentials.set(accountKey, { ...credentials });
          if (credentials.authMethod == "negotiate" && credentials.host) {
            const pref = "network.negotiate-auth.trusted-uris";
            const list = Services.prefs.getStringPref(pref, "").split(",").map(s => s.trim()).filter(Boolean);
            if (!list.includes(credentials.host)) {
              list.push(credentials.host);
              Services.prefs.setStringPref(pref, list.join(","));
            }
          }
          if (prev && (prev.username != credentials.username || prev.password != credentials.password)) {
            // Forget connection-bound NTLM/Negotiate state from the old identity.
            Services.obs.notifyObservers(null, "net:clear-active-logins");
          }
        },

        async clearCredentials(accountKey) {
          self.credentials.delete(accountKey);
          Services.obs.notifyObservers(null, "net:clear-active-logins");
        },

        async storeSecret(name, username, secret) {
          await setLogin(`${SECRET_ORIGIN}/${encodeURIComponent(name)}`, DAV_REALM, username, secret);
        },

        async loadSecret(name) {
          const logins = await findLogins(`${SECRET_ORIGIN}/${encodeURIComponent(name)}`, DAV_REALM);
          return logins.length ? { username: logins[0].username, secret: logins[0].password } : null;
        },

        async deleteSecret(name) {
          await removeLogins(`${SECRET_ORIGIN}/${encodeURIComponent(name)}`, DAV_REALM, null);
        },

        async randomToken() {
          const rng = Cc["@mozilla.org/security/random-generator;1"].getService(Ci.nsIRandomGenerator);
          return Array.from(rng.generateRandomBytes(24), b => b.toString(16).padStart(2, "0")).join("");
        },

        async configureAccount(config) {
          try {
            return await configureAccount(config);
          } catch (e) {
            console.error("EWS Bridge: configureAccount failed", e);
            throw new ExtensionError(`${e.message} (${e.fileName?.split("/").pop()}:${e.lineNumber})`);
          }
        },

        async updatePorts(config) {
          await updatePorts(config);
        },

        async fixIdentityFolders(email) {
          return fixIdentityFolders(email);
        },

        async removeAccount(config) {
          await removeAccount(config);
        },

        async kickSync(email) {
          return kickSync(email);
        },

        async accountExists(email) {
          return !!findOurImapServer(email);
        },

        async listTags() {
          return MailServices.tags.getAllTags().map(t => ({ key: t.key, tag: t.tag, color: t.color }));
        },

        async ensureTag(name) {
          for (const t of MailServices.tags.getAllTags()) {
            if (t.tag.toLowerCase() == name.toLowerCase()) {
              return t.key;
            }
          }
          MailServices.tags.addTag(name, "", "");
          return MailServices.tags.getKeyForTag(name);
        },

        onConnection: makeEvent("onConnection", "connection"),
        onData: makeEvent("onData", "data"),
        onClosed: makeEvent("onClosed", "closed"),
      },
    };
  }
};

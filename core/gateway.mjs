/* EWS Bridge — ties one or more Exchange accounts to the local IMAP,
 * SMTP and CalDAV/CardDAV endpoints. Platform specifics (sockets, HTTP with
 * NTLM, storage, timers) come in through `platform`.
 *
 * platform = {
 *   listen(port, onConnection) -> Promise<{ port, close() }>
 *        onConnection(conn) must return a session { data(bin), close() };
 *        conn = { write(bin), close() }
 *   transportFor(accountConfig) -> EWS transport
 *   tagsFor(accountConfig) -> { categoryToKeyword, keywordToCategory } (optional)
 *   store, timers, defaultTimeZone, logSink(level, msg)
 * }
 */

import { EwsClient } from "./ews/client.mjs";
import { MailAccount } from "./imap/mailbox.mjs";
import { ImapSession } from "./imap/session.mjs";
import { SmtpSession, ewsSender } from "./smtp/session.mjs";
import { HttpSession } from "./dav/http.mjs";
import { DavServer } from "./dav/server.mjs";
import { ExchangeCalendar } from "./cal/calendar.mjs";
import { ExchangeAddressBook } from "./contacts/addressbook.mjs";
import { galEntryToVCard } from "./contacts/convert.mjs";
import { Logger, fnv1a } from "./util.mjs";

function safeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export class AccountContext {
  constructor(config, gateway) {
    this.config = config; // { key, email, displayName, ewsUrl, username, localPassword }
    this.key = config.key;
    this.email = config.email;
    this.displayName = config.displayName || config.email;
    this.gateway = gateway;
    const p = gateway.platform;
    this.log = gateway.log.child(`[${config.email}] `);
    this.ews = new EwsClient({
      url: config.ewsUrl,
      transport: p.transportFor(config),
      log: this.log,
      setTimeout: p.timers.setTimeout,
    });
    this.mail = new MailAccount({
      ews: this.ews,
      store: p.store,
      key: `acct-${config.key}`,
      log: this.log,
      timers: p.timers,
      tags: p.tagsFor?.(config) || null,
    });
    this.sender = ewsSender(this.ews);
    this.calendars = [];
    this.addressBooks = [];
    this.collectionsLoaded = null;
  }

  /** Discover calendar and contact folders (once, then on demand). */
  ensureCollections(force = false) {
    if (this.collectionsLoaded && !force) {
      return this.collectionsLoaded;
    }
    const p = this.gateway.platform;
    const common = { ews: this.ews, store: p.store, log: this.log };
    this.collectionsLoaded = (async () => {
      const calendars = [
        new ExchangeCalendar({
          ...common,
          key: `cal-${this.key}-default`,
          id: "calendar",
          folder: "@calendar",
          displayName: "Calendar",
          ownEmail: this.email,
          defaultTz: p.defaultTimeZone,
        }),
      ];
      const books = [
        new ExchangeAddressBook({ ...common, key: `ab-${this.key}-default`, id: "contacts", folder: "@contacts", displayName: "Contacts" }),
      ];
      try {
        const d = await this.ews.getDistinguishedFolders();
        const skip = new Set([d.calendar?.id, d.contacts?.id].filter(Boolean));
        calendars[0].displayName = d.calendar?.displayName || "Calendar";
        books[0].displayName = d.contacts?.displayName || "Contacts";
        for (const f of await this.ews.findFoldersDeep("@msgfolderroot")) {
          if (skip.has(f.id)) {
            continue;
          }
          const id = `f${fnv1a(f.id)}`;
          if (f.kind == "CalendarFolder" && f.folderClass == "IPF.Appointment") {
            calendars.push(
              new ExchangeCalendar({
                ...common,
                key: `cal-${this.key}-${id}`,
                id,
                folder: f.id,
                displayName: f.displayName,
                ownEmail: this.email,
                defaultTz: p.defaultTimeZone,
              })
            );
          } else if (f.kind == "ContactsFolder" && f.folderClass == "IPF.Contact") {
            books.push(new ExchangeAddressBook({ ...common, key: `ab-${this.key}-${id}`, id, folder: f.id, displayName: f.displayName }));
          }
        }
      } catch (e) {
        this.log.warn(`folder discovery failed: ${e.message}`);
        this.collectionsLoaded = null; // retry on next request
      }
      this.calendars = calendars;
      this.addressBooks = books;
    })();
    return this.collectionsLoaded;
  }

  /** Global Address List lookup for autocomplete. */
  async searchGal(query) {
    if (!query || query.trim().length < 2) {
      return [];
    }
    const hits = await this.ews.resolveNames(query.trim(), { scope: "ActiveDirectory", fullContactData: true });
    return hits
      .filter(h => h.email && h.email.includes("@"))
      .map(h => ({ name: h.name, email: h.email, vCard: galEntryToVCard(h) }));
  }
}

export class Gateway {
  constructor({ platform, logLevel = "info" }) {
    this.platform = platform;
    this.logBuffer = [];
    const sink = (lvl, msg) => {
      this.logBuffer.push(`${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}`);
      if (this.logBuffer.length > 1000) {
        this.logBuffer.splice(0, this.logBuffer.length - 1000);
      }
      platform.logSink?.(lvl, msg);
    };
    this.log = new Logger(sink, logLevel, "");
    this.accounts = new Map(); // key -> AccountContext
    this.listeners = {};
    this.ports = { imap: 0, smtp: 0, dav: 0 };
    this.sessions = new Set();
  }

  setLogLevel(level) {
    this.log.level = level;
  }

  addAccount(config) {
    const ctx = new AccountContext(config, this);
    this.accounts.set(config.key, ctx);
    this.log.info(`account ${config.email} → ${config.ewsUrl}`);
    return ctx;
  }

  async removeAccount(key) {
    const ctx = this.accounts.get(key);
    if (ctx) {
      await ctx.mail.flush().catch(() => {});
      this.accounts.delete(key);
    }
  }

  /** Match local-gateway credentials (username = e-mail address or account key). */
  authenticate(user, pass) {
    const u = String(user || "").toLowerCase();
    for (const ctx of this.accounts.values()) {
      if ((ctx.email.toLowerCase() == u || ctx.key == u) && safeEqual(pass, ctx.config.localPassword)) {
        return ctx;
      }
    }
    this.log.warn(`local login rejected for "${user}"`);
    return null;
  }

  /**
   * Start listening. `ports` are preferred ports; 0 picks a free one.
   * Returns the ports actually in use.
   */
  async start(ports = {}) {
    const p = this.platform;
    const track = session => {
      this.sessions.add(session);
      const close = session.close.bind(session);
      session.close = () => {
        this.sessions.delete(session);
        close();
      };
      return session;
    };
    const listen = async (name, preferred, factory) => {
      let handle;
      try {
        handle = await p.listen(preferred || 0, factory);
      } catch (e) {
        this.log.warn(`${name}: port ${preferred} unavailable (${e.message}), choosing another`);
        handle = await p.listen(0, factory);
      }
      this.listeners[name] = handle;
      this.ports[name] = handle.port;
      this.log.info(`${name.toUpperCase()} gateway listening on 127.0.0.1:${handle.port}`);
    };
    await listen("imap", ports.imap, conn =>
      track(
        new ImapSession({
          conn,
          log: this.log.child("[imap] "),
          timers: p.timers,
          authenticate: async (u, pw) => this.authenticate(u, pw)?.mail || null,
        })
      )
    );
    await listen("smtp", ports.smtp, conn =>
      track(new SmtpSession({ conn, log: this.log.child("[smtp] "), authenticate: async (u, pw) => this.authenticate(u, pw)?.sender || null }))
    );
    const dav = new DavServer({
      log: this.log.child("[dav] "),
      authenticate: async (u, pw) => {
        const ctx = this.authenticate(u, pw);
        if (ctx) {
          await ctx.ensureCollections();
        }
        return ctx;
      },
    });
    await listen("dav", ports.dav, conn => track(new HttpSession({ conn, log: this.log.child("[http] "), handler: req => dav.handle(req) })));
    return { ...this.ports };
  }

  async stop() {
    for (const s of [...this.sessions]) {
      try {
        s.close();
      } catch {}
    }
    for (const l of Object.values(this.listeners)) {
      try {
        await l.close();
      } catch {}
    }
    this.listeners = {};
    for (const ctx of this.accounts.values()) {
      await ctx.mail.flush().catch(() => {});
    }
  }

  status() {
    return {
      ports: { ...this.ports },
      sessions: this.sessions.size,
      accounts: [...this.accounts.values()].map(a => ({
        key: a.key,
        email: a.email,
        ewsUrl: a.config.ewsUrl,
        requests: a.ews.requestCount,
        serverVersion: a.ews.serverVersion?.build || null,
        schema: a.ews.version,
        folders: a.mail.folders().length,
        calendars: a.calendars.map(c => c.displayName),
        addressBooks: a.addressBooks.map(b => b.displayName),
      })),
    };
  }
}

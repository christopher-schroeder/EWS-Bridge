/* EWS Bridge — background page: starts the gateway, manages accounts
 * and answers requests from the settings page. */

import { Gateway } from "./core/gateway.mjs";
import { EwsClient } from "./core/ews/client.mjs";
import { autodiscover, guessEwsUrls } from "./core/ews/autodiscover.mjs";
import { createTbPlatform, transportForKey } from "./platform/tb.mjs";

const api = browser.ewsBridge;

const state = {
  config: null,
  gateway: null,
  platform: null,
  ready: null,
  error: null,
  galListeners: new Map(),
};

async function loadConfig() {
  const r = await browser.storage.local.get("config");
  return r.config || { version: 1, accounts: [], ports: {}, logLevel: "info" };
}

async function saveConfig() {
  await browser.storage.local.set({ config: state.config });
}

function randomKey() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

async function activate(acct) {
  const ews = await api.loadSecret(`ews:${acct.key}`);
  const local = await api.loadSecret(`local:${acct.key}`);
  if (!local) {
    throw new Error(`Local gateway password for ${acct.email} is missing`);
  }
  await api.setCredentials(acct.key, {
    username: acct.username,
    password: ews?.secret || "",
    authMethod: acct.authMethod || "auto",
    host: new URL(acct.ewsUrl).host,
  });
  const ctx = state.gateway.addAccount({ ...acct, localPassword: local.secret });
  registerGal(acct);
  return ctx;
}

function registerGal(acct) {
  if (state.galListeners.has(acct.key) || !browser.addressBooks?.provider) {
    return;
  }
  const listener = async (node, searchString) => {
    const ctx = state.gateway.accounts.get(acct.key);
    if (!ctx || !searchString) {
      return { results: [], isCompleteResult: false };
    }
    try {
      const hits = await ctx.searchGal(searchString);
      return { results: hits.map(h => ({ vCard: h.vCard })), isCompleteResult: hits.length < 100 };
    } catch (e) {
      state.gateway.log.warn(`GAL search failed: ${e.message}`);
      return { results: [], isCompleteResult: false };
    }
  };
  try {
    browser.addressBooks.provider.onSearchRequest.addListener(listener, {
      addressBookName: `Directory (${acct.email})`,
      isSecure: true,
      id: `gal-${acct.key}`,
    });
    state.galListeners.set(acct.key, listener);
  } catch (e) {
    console.warn("EWS Bridge: GAL provider registration failed", e);
  }
}

function unregisterGal(key) {
  const l = state.galListeners.get(key);
  if (l) {
    browser.addressBooks.provider.onSearchRequest.removeListener(l);
    state.galListeners.delete(key);
  }
}

async function startup() {
  state.config = await loadConfig();
  state.platform = createTbPlatform({
    logSink: (lvl, msg) => {
      if (lvl == "error" || lvl == "warn") {
        console[lvl == "error" ? "error" : "warn"](`EWS Bridge: ${msg}`);
      }
    },
  });
  await state.platform.init();
  state.gateway = new Gateway({ platform: state.platform, logLevel: state.config.logLevel || "info" });
  for (const acct of state.config.accounts) {
    try {
      await activate(acct);
    } catch (e) {
      state.gateway.log.error(`cannot activate ${acct.email}: ${e.message}`);
    }
  }
  const oldPorts = { ...state.config.ports };
  const ports = await state.gateway.start(state.config.ports);
  if (ports.imap != oldPorts.imap || ports.smtp != oldPorts.smtp || ports.dav != oldPorts.dav) {
    state.config.ports = ports;
    await saveConfig();
    for (const acct of state.config.accounts) {
      const ctx = state.gateway.accounts.get(acct.key);
      if (ctx && oldPorts.imap) {
        await api.updatePorts({ key: acct.key, email: acct.email, localPassword: ctx.config.localPassword, ports, oldPorts });
      }
    }
  }
  await api.rememberPorts(ports);
  // Thunderbird's own startup check may have run before the gateway was ready.
  for (const acct of state.config.accounts) {
    api.kickSync(acct.email).catch(() => {});
  }
  // Point identity Drafts/Sent at the special-use folders once Thunderbird has discovered them.
  setTimeout(() => {
    for (const acct of state.config.accounts) {
      api.fixIdentityFolders(acct.email).catch(() => {});
    }
  }, 60000);
}

// ---------------------------------------------------------------------------
// Connection test: tries autodiscover, then conventional URLs, and several
// username forms, and reports every attempt so failures are understandable.

function usernameCandidates(email, username) {
  if (username) {
    return [username];
  }
  const local = email.split("@")[0];
  return [...new Set([email, local])];
}

async function testConnection({ email, password, username = "", ewsUrl = "", authMethod = "auto" }) {
  const key = `test-${randomKey()}`;
  const attempts = [];
  const lastResponses = new Map();
  const transport = transportForKey(key, lastResponses);
  const setCreds = (u, url) => api.setCredentials(key, { username: u, password, authMethod, host: url ? new URL(url).host : "" });
  const users = usernameCandidates(email.trim(), username.trim());
  let urls = ewsUrl ? [ewsUrl.trim()] : [];
  let displayName = null;
  let sawAuthFailure = false;
  let offered = null;
  try {
    if (!urls.length) {
      for (const u of users) {
        await setCreds(u, `https://${email.split("@")[1]}`);
        try {
          const ad = await autodiscover(email.trim(), transport);
          urls = [ad.ewsUrl];
          displayName = ad.displayName;
          attempts.push(`✓ Autodiscover found ${ad.ewsUrl}`);
          break;
        } catch (e) {
          attempts.push(`✗ Autodiscover (as ${u}): ${e.message.split("\n")[0]}`);
        }
      }
      if (!urls.length) {
        urls = guessEwsUrls(email.trim());
        attempts.push(`… trying common EWS addresses`);
      }
    }
    for (const url of urls) {
      for (const u of users) {
        await setCreds(u, url);
        const client = new EwsClient({ url, transport });
        try {
          await client.probe();
          if (!displayName) {
            try {
              const me = await client.resolveNames(email.trim(), { fullContactData: false, scope: "ActiveDirectory" });
              displayName = me.find(m => m.email.toLowerCase() == email.trim().toLowerCase())?.name || me[0]?.name || null;
            } catch {}
          }
          attempts.push(`✓ ${url} — logged in as ${u}`);
          return {
            ok: true,
            ewsUrl: url,
            username: u,
            displayName: displayName || email,
            serverVersion: client.serverVersion?.build || null,
            schema: client.version,
            authScheme: lastResponses.get(key)?.authScheme || null,
            attempts,
          };
        } catch (e) {
          const lr = lastResponses.get(key);
          if (e.name == "EwsAuthError") {
            sawAuthFailure = true;
            offered = lr?.headers?.["www-authenticate"] || offered;
          }
          attempts.push(`✗ ${url} (as ${u}): ${e.message}`);
          if (e.name == "EwsNetworkError" || e.code == "HTTP404" || e.code == "InvalidResponse") {
            break; // this URL is not usable; next URL
          }
        }
      }
    }
    let hint = "Could not connect.";
    if (sawAuthFailure) {
      hint =
        "The server was reached but rejected the login. Check the password, and try the username in the form DOMAIN\\user or user@domain." +
        (offered ? ` The server offers: ${offered}.` : "");
    } else if (attempts.some(a => a.includes("certificate"))) {
      hint = "The server's TLS certificate is not trusted by Thunderbird.";
    } else if (!ewsUrl) {
      hint = "No EWS endpoint was found automatically. Enter the EWS URL (usually https://<mail server>/EWS/Exchange.asmx).";
    }
    return { ok: false, hint, attempts };
  } finally {
    api.clearCredentials(key).catch(() => {});
  }
}

async function addAccount(params) {
  await state.ready;
  const email = params.email.trim();
  if (state.config.accounts.some(a => a.email.toLowerCase() == email.toLowerCase())) {
    throw new Error("This account is already configured.");
  }
  const key = randomKey();
  const localPassword = await api.randomToken();
  await api.storeSecret(`ews:${key}`, params.username, params.password);
  await api.storeSecret(`local:${key}`, email, localPassword);
  const acct = {
    key,
    email,
    displayName: params.displayName || email,
    ewsUrl: params.ewsUrl,
    username: params.username,
    authMethod: params.authMethod || "auto",
    created: Date.now(),
  };
  const ctx = await activate(acct);
  await ctx.mail.refreshFolders({ force: true });
  await ctx.ensureCollections(true);
  const trash = ctx.mail.specialFolder("deleteditems");
  const result = await api.configureAccount({
    key,
    email,
    displayName: acct.displayName,
    localPassword,
    ports: state.gateway.ports,
    trashFolder: trash?.name || null,
    calendars: params.calendars === false ? [] : ctx.calendars.map((c, i) => ({ id: c.id, name: c.displayName, primary: i == 0 })),
    addressBooks: params.contacts === false ? [] : ctx.addressBooks.map((b, i) => ({ id: b.id, name: b.displayName, primary: i == 0 })),
  });
  acct.tbAccountKey = result.accountKey;
  state.config.accounts.push(acct);
  await saveConfig();
  api.kickSync(email).catch(() => {});
  setTimeout(() => api.fixIdentityFolders(email).catch(() => {}), 20000);
  return { key, created: result.created };
}

async function removeAccount({ key, removeData = true }) {
  const acct = state.config.accounts.find(a => a.key == key);
  if (!acct) {
    return;
  }
  unregisterGal(key);
  await state.gateway.removeAccount(key);
  await api.removeAccount({ key, email: acct.email, ports: state.config.ports, removeData });
  await api.deleteSecret(`ews:${key}`);
  await api.deleteSecret(`local:${key}`);
  await api.clearCredentials(key);
  const stored = await browser.storage.local.get(null);
  await browser.storage.local.remove(Object.keys(stored).filter(k => k.includes(`-${key}`)));
  state.config.accounts = state.config.accounts.filter(a => a.key != key);
  await saveConfig();
}

async function updatePassword({ key, password, username }) {
  const acct = state.config.accounts.find(a => a.key == key);
  if (!acct) {
    throw new Error("Unknown account");
  }
  if (username) {
    acct.username = username;
    await saveConfig();
  }
  await api.storeSecret(`ews:${key}`, acct.username, password);
  await api.setCredentials(key, { username: acct.username, password, authMethod: acct.authMethod || "auto", host: new URL(acct.ewsUrl).host });
  const ctx = state.gateway.accounts.get(key);
  await ctx.ews.probe();
  return { ok: true };
}

async function getState() {
  await state.ready.catch(() => {});
  return {
    error: state.error,
    accounts: state.config?.accounts || [],
    status: state.gateway?.status() || null,
    logLevel: state.config?.logLevel || "info",
    log: state.gateway?.logBuffer.slice(-300) || [],
  };
}

async function handleMessage(msg) {
  try {
    switch (msg?.type) {
      case "getState":
        return await getState();
      case "testConnection":
        await state.ready;
        return await testConnection(msg.params);
      case "addAccount":
        return await addAccount(msg.params);
      case "removeAccount":
        await state.ready;
        await removeAccount(msg.params);
        return { ok: true };
      case "updatePassword":
        await state.ready;
        return await updatePassword(msg.params);
      case "setLogLevel":
        state.config.logLevel = msg.level;
        state.gateway.setLogLevel(msg.level);
        await saveConfig();
        return { ok: true };
      case "checkAccount": {
        await state.ready;
        const ctx = state.gateway.accounts.get(msg.key);
        const r = await ctx.ews.probe();
        return { ok: true, inbox: r.inbox?.displayName, unread: r.inbox?.unreadCount, serverVersion: r.serverVersion?.build };
      }
      default:
        return { error: `unknown message ${msg?.type}` };
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

browser.runtime.onMessage.addListener(msg => handleMessage(msg));
// Same-page callers (runtime.sendMessage does not reach the sending page).
globalThis.ewsBridge = { handleMessage, state };

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason == "install") {
    browser.runtime.openOptionsPage().catch(() => {});
  }
});

state.ready = startup().catch(e => {
  state.error = e.message;
  console.error("EWS Bridge: startup failed", e);
  throw e;
});

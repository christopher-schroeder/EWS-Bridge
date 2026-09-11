/* EWS Bridge — Thunderbird platform adapter for the gateway core.
 * Runs in the (unprivileged) background page and talks to the privileged
 * experiment API `browser.ewsBridge`.
 */

import { EwsNetworkError } from "../core/ews/soap.mjs";
import { defaultCategoryToKeyword } from "../core/imap/mailbox.mjs";

const api = () => browser.ewsBridge;

/** Persistent JSON documents in storage.local (IndexedDB-backed). */
class StorageStore {
  async load(key) {
    const k = `store:${key}`;
    const r = await browser.storage.local.get(k);
    return r[k] ?? null;
  }

  async save(key, value) {
    await browser.storage.local.set({ [`store:${key}`]: value });
  }

  async remove(key) {
    await browser.storage.local.remove(`store:${key}`);
  }
}

export function createTbPlatform({ logSink }) {
  const factories = new Map(); // serverId -> onConnection
  const sessions = new Map(); // connId -> session
  const early = new Map(); // connId -> [data] (arrived before onConnection)
  const lastResponses = new Map(); // accountKey -> { status, headers }

  function makeConn(connId) {
    let buf = [];
    let scheduled = false;
    let closed = false;
    const flush = () => {
      scheduled = false;
      if (!buf.length) {
        return;
      }
      const data = buf.join("");
      buf = [];
      api().write(connId, data).catch(() => {});
    };
    return {
      write(bin) {
        if (closed) {
          return;
        }
        buf.push(bin);
        if (!scheduled) {
          scheduled = true;
          Promise.resolve().then(flush);
        }
      },
      close() {
        if (closed) {
          return;
        }
        closed = true;
        flush();
        api().closeConnection(connId).catch(() => {});
      },
    };
  }

  const unclaimed = new Map(); // serverId -> [connId] accepted before listen() adopted the server
  function startSession(serverId, connId) {
    const factory = factories.get(serverId);
    const session = factory(makeConn(connId));
    sessions.set(connId, session);
    const pending = early.get(connId);
    if (pending) {
      early.delete(connId);
      pending.forEach(d => session.data(d));
    }
  }

  api().onConnection.addListener((serverId, connId) => {
    if (factories.has(serverId)) {
      startSession(serverId, connId);
    } else {
      if (!unclaimed.has(serverId)) {
        unclaimed.set(serverId, []);
      }
      unclaimed.get(serverId).push(connId);
    }
  });

  api().onData.addListener((connId, data) => {
    const s = sessions.get(connId);
    if (s) {
      s.data(data);
    } else {
      if (!early.has(connId)) {
        early.set(connId, []);
      }
      early.get(connId).push(data);
    }
  });

  api().onClosed.addListener(connId => {
    const s = sessions.get(connId);
    sessions.delete(connId);
    early.delete(connId);
    try {
      s?.close();
    } catch {}
  });

  // Exchange categories <-> Thunderbird tags
  const tags = { byKey: new Map(), keyByName: new Map() };
  async function loadTags() {
    try {
      for (const t of await api().listTags()) {
        tags.byKey.set(t.key.toLowerCase(), t.tag);
        tags.keyByName.set(t.tag.toLowerCase(), t.key);
      }
    } catch (e) {
      logSink?.("warn", `could not read tags: ${e.message}`);
    }
  }
  const tagMapper = {
    categoryToKeyword(name) {
      const known = tags.keyByName.get(name.toLowerCase());
      if (known) {
        return known;
      }
      const guess = defaultCategoryToKeyword(name);
      tags.keyByName.set(name.toLowerCase(), guess);
      tags.byKey.set(guess.toLowerCase(), name);
      api()
        .ensureTag(name)
        .then(key => {
          tags.keyByName.set(name.toLowerCase(), key);
          tags.byKey.set(key.toLowerCase(), name);
        })
        .catch(() => {});
      return guess;
    },
    keywordToCategory(kw) {
      return tags.byKey.get(kw.toLowerCase()) || null;
    },
  };

  return {
    store: new StorageStore(),
    defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    logSink,
    timers: {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: id => clearTimeout(id),
      setInterval: (f, ms) => setInterval(f, ms),
      clearInterval: id => clearInterval(id),
    },
    init: loadTags,
    async listen(port, onConnection) {
      const { serverId, port: actual } = await api().listen(port);
      factories.set(serverId, onConnection);
      for (const connId of unclaimed.get(serverId) || []) {
        startSession(serverId, connId);
      }
      unclaimed.delete(serverId);
      return {
        port: actual,
        close: async () => {
          factories.delete(serverId);
          await api().stopListening(serverId);
        },
      };
    },
    transportFor(config) {
      return transportForKey(config.key, lastResponses);
    },
    tagsFor() {
      return tagMapper;
    },
    lastResponse(key) {
      return lastResponses.get(key) || null;
    },
  };
}

/** EWS transport that routes through the experiment with the given credentials key. */
export function transportForKey(key, lastResponses = null) {
  return {
    async request(o) {
      const r = await api().httpRequest({ ...o, accountKey: key });
      if (r.error) {
        throw new EwsNetworkError(r.error, { kind: r.errorKind });
      }
      lastResponses?.set(key, { status: r.status, headers: r.headers, authScheme: r.authScheme });
      return r;
    },
  };
}

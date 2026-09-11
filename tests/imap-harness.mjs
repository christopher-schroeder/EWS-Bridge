import { MockExchange, basicTransport } from "./mock-ews.mjs";
import { EwsClient } from "../core/ews/client.mjs";
import { MailAccount } from "../core/imap/mailbox.mjs";
import { ImapSession } from "../core/imap/session.mjs";
import { MemoryStore } from "../core/store.mjs";

export const MSG = (subj, { from = "Alice <alice@example.org>", body = `Hello ${subj}`, extra = "" } = {}) =>
  `From: ${from}\r\nTo: user@example.org\r\nSubject: ${subj}\r\nDate: Tue, 1 Sep 2026 10:00:00 +0000\r\nMessage-ID: <${subj.replace(/\W/g, "")}@x>\r\n${extra}\r\n${body}\r\n`;

export class TestConn {
  constructor() { this.out = ""; this.closed = false; }
  write(b) { this.out += b; }
  close() { this.closed = true; }
}

export async function setupImap({ store = new MemoryStore(), ex = new MockExchange() } = {}) {
  const server = ex.serve();
  const ews = new EwsClient({ url: ex.url, transport: basicTransport("user", "secret") });
  const account = new MailAccount({ ews, store, key: "acct", minSyncIntervalMs: 0 });
  const sessions = [];
  const open = () => {
    const conn = new TestConn();
    const session = new ImapSession({ conn, authenticate: async (u, p) => (u == "user@example.org" && p == "tok" ? account : null), idlePollMs: 50 });
    sessions.push(session);
    let mark = 0;
    let n = 0;
    const c = {
      conn, session,
      async cmd(text, { literal = null } = {}) {
        const tag = `a${++n}`;
        mark = conn.out.length;
        session.data(`${tag} ${text}\r\n`);
        if (literal !== null) session.data(literal);
        const re = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`);
        for (let i = 0; i < 2000; i++) {
          const s = conn.out.slice(mark);
          if (re.test(s)) return s;
          await new Promise(r => setTimeout(r, 2));
        }
        throw new Error(`timeout waiting for ${tag}; got:\n${conn.out.slice(mark)}`);
      },
      async login() { return c.cmd("LOGIN user@example.org tok"); },
      raw(text) { session.data(text); },
      since(i) { return conn.out.slice(i); },
    };
    return c;
  };
  return {
    ex, server, ews, account, store, open,
    async close() {
      sessions.forEach(s => s.close());
      await account.flush();
      await server.shutdown();
    },
  };
}

/* EWS Bridge — SMTP submission gateway: messages are sent through
 * EWS CreateItem (SendAndSaveCopy), so Exchange delivers them and stores the
 * copy in Sent Items.
 */

import { base64Decode, redact } from "../util.mjs";
import { parseMime, parseAddressList, setHeader, toCRLF } from "../mime.mjs";
import { EwsAuthError, EwsNetworkError } from "../ews/soap.mjs";

const MAX_SIZE = 150 * 1024 * 1024;

export class SmtpSession {
  /**
   * @param {object} o
   * @param {object} o.conn  { write(bin), close() }
   * @param {Function} o.authenticate  async (user, pass) -> { send(mime, recipients) } | null
   */
  constructor({ conn, authenticate, log = null, hostname = "localhost" }) {
    this.conn = conn;
    this.authenticate = authenticate;
    this.log = log;
    this.hostname = hostname;
    this.buffer = "";
    this.state = "command"; // command | data | auth-plain | auth-login-user | auth-login-pass
    this.account = null;
    this.reset();
    this.queue = Promise.resolve();
    this.closed = false;
    this.#reply(220, `${hostname} EWS Bridge ESMTP ready`);
  }

  reset() {
    this.from = null;
    this.rcpts = [];
  }

  #reply(code, text) {
    if (this.closed) {
      return;
    }
    const lines = Array.isArray(text) ? text : [text];
    const out = lines.map((l, i) => `${code}${i < lines.length - 1 ? "-" : " "}${l}`).join("\r\n") + "\r\n";
    this.conn.write(out);
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      try {
        this.conn.close();
      } catch {}
    }
  }

  data(bin) {
    this.buffer += bin;
    this.queue = this.queue.then(() => this.#drain()).catch(e => {
      this.log?.error(`SMTP: ${e.stack || e.message}`);
      this.#reply(451, `4.3.0 ${e.message}`);
    });
  }

  async #drain() {
    for (;;) {
      if (this.state == "data") {
        let end = this.buffer.indexOf("\r\n.\r\n");
        let skip = 5;
        if (this.buffer.startsWith(".\r\n")) {
          end = 0;
          skip = 3;
        }
        if (end < 0) {
          if (this.buffer.length > MAX_SIZE) {
            this.buffer = "";
            this.state = "command";
            this.#reply(552, "5.3.4 Message too big");
          }
          return;
        }
        const raw = end == 0 && skip == 3 ? "" : this.buffer.slice(0, end + 2);
        this.buffer = this.buffer.slice(end + skip);
        this.state = "command";
        // Undo dot-stuffing (RFC 5321 §4.5.2).
        await this.#deliver(raw.replace(/(^|\r\n)\./g, "$1"));
        continue;
      }
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) {
        return;
      }
      let line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      await this.#line(line);
      if (this.closed) {
        return;
      }
    }
  }

  async #line(line) {
    if (this.state == "auth-plain") {
      this.state = "command";
      return this.#authPlain(line);
    }
    if (this.state == "auth-login-user") {
      this.loginUser = base64Decode(line);
      this.state = "auth-login-pass";
      return this.#reply(334, "UGFzc3dvcmQ6");
    }
    if (this.state == "auth-login-pass") {
      this.state = "command";
      return this.#finishAuth(this.loginUser, base64Decode(line));
    }
    const [verbRaw, ...rest] = line.split(" ");
    const verb = verbRaw.toUpperCase();
    const arg = rest.join(" ");
    this.log?.debug(`SMTP C: ${redact(verb == "AUTH" ? "AUTH ..." : line)}`);
    switch (verb) {
      case "EHLO":
        this.reset();
        return this.#reply(250, [this.hostname, "8BITMIME", `SIZE ${MAX_SIZE}`, "AUTH PLAIN LOGIN", "ENHANCEDSTATUSCODES", "PIPELINING"]);
      case "HELO":
        this.reset();
        return this.#reply(250, this.hostname);
      case "NOOP":
        return this.#reply(250, "2.0.0 OK");
      case "RSET":
        this.reset();
        return this.#reply(250, "2.0.0 OK");
      case "QUIT":
        this.#reply(221, "2.0.0 Bye");
        return this.close();
      case "VRFY":
        return this.#reply(252, "2.5.0 Cannot verify, but will attempt delivery");
      case "STARTTLS":
        return this.#reply(454, "4.7.0 TLS not available on the local gateway");
      case "AUTH": {
        if (this.account) {
          return this.#reply(503, "5.5.1 Already authenticated");
        }
        const [mech, initial] = arg.split(" ");
        if (mech?.toUpperCase() == "PLAIN") {
          if (initial) {
            return this.#authPlain(initial);
          }
          this.state = "auth-plain";
          return this.#reply(334, "");
        }
        if (mech?.toUpperCase() == "LOGIN") {
          if (initial) {
            this.loginUser = base64Decode(initial);
            this.state = "auth-login-pass";
            return this.#reply(334, "UGFzc3dvcmQ6");
          }
          this.state = "auth-login-user";
          return this.#reply(334, "VXNlcm5hbWU6");
        }
        return this.#reply(504, "5.5.4 Unsupported authentication mechanism");
      }
      case "MAIL": {
        if (!this.account) {
          return this.#reply(530, "5.7.0 Authentication required");
        }
        const m = /^FROM:\s*<([^>]*)>/i.exec(arg);
        if (!m) {
          return this.#reply(501, "5.5.4 Syntax: MAIL FROM:<address>");
        }
        const size = /\bSIZE=(\d+)/i.exec(arg);
        if (size && parseInt(size[1], 10) > MAX_SIZE) {
          return this.#reply(552, "5.3.4 Message too big");
        }
        this.reset();
        this.from = m[1];
        return this.#reply(250, "2.1.0 Sender OK");
      }
      case "RCPT": {
        if (this.from === null) {
          return this.#reply(503, "5.5.1 Need MAIL command");
        }
        const m = /^TO:\s*<([^>]+)>/i.exec(arg);
        if (!m) {
          return this.#reply(501, "5.5.4 Syntax: RCPT TO:<address>");
        }
        this.rcpts.push(m[1]);
        return this.#reply(250, "2.1.5 Recipient OK");
      }
      case "DATA":
        if (!this.rcpts.length) {
          return this.#reply(503, "5.5.1 Need RCPT command");
        }
        this.state = "data";
        return this.#reply(354, "Start mail input; end with <CRLF>.<CRLF>");
      default:
        return this.#reply(500, `5.5.2 Command not recognized`);
    }
  }

  async #authPlain(b64) {
    const [, user, pass] = base64Decode(b64).split("\0");
    return this.#finishAuth(user || "", pass || "");
  }

  async #finishAuth(user, pass) {
    try {
      this.account = await this.authenticate(user, pass);
    } catch (e) {
      return this.#reply(454, `4.7.0 Temporary authentication failure: ${e.message}`);
    }
    if (!this.account) {
      return this.#reply(535, "5.7.8 Invalid credentials for the local gateway");
    }
    return this.#reply(235, "2.7.0 Authentication successful");
  }

  async #deliver(mime) {
    const rcpts = this.rcpts;
    this.reset();
    try {
      await this.account.send(toCRLF(mime), rcpts);
      this.#reply(250, "2.0.0 Message handed to Exchange");
    } catch (e) {
      this.log?.warn(`send failed: ${e.message}`);
      if (e instanceof EwsAuthError || e instanceof EwsNetworkError) {
        return this.#reply(451, `4.4.1 Exchange not available: ${oneLine(e.message)}`);
      }
      this.#reply(554, `5.0.0 Exchange refused the message: ${oneLine(e.message)}`);
    }
  }
}

/**
 * Add a Bcc header for envelope recipients that are not visible in
 * To/Cc/Bcc so Exchange delivers to them (it takes recipients from MIME).
 */
export function prepareForExchange(mime, rcpts) {
  const root = parseMime(mime);
  const visible = new Set();
  for (const h of ["To", "Cc", "Bcc"]) {
    for (const v of root.headers.getAll(h)) {
      for (const a of parseAddressList(v)) {
        visible.add(a.email.toLowerCase());
      }
    }
  }
  const hidden = rcpts.filter(r => !visible.has(r.toLowerCase()));
  if (!hidden.length) {
    return mime;
  }
  const existing = root.headers.get("Bcc");
  return setHeader(mime, "Bcc", existing ? `${existing}, ${hidden.join(", ")}` : hidden.join(", "));
}

/** Account adapter: send through EWS. */
export function ewsSender(ews) {
  return {
    async send(mime, rcpts) {
      await ews.createItemFromMime(prepareForExchange(mime, rcpts), { folder: "@sentitems", disposition: "SendAndSaveCopy" });
    },
  };
}

function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, " ").slice(0, 300);
}

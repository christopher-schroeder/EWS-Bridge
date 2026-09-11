/* EWS Bridge — minimal HTTP/1.1 server session (keep-alive, chunked
 * request bodies) for the local CalDAV/CardDAV endpoints.
 */

import { utf8Encode } from "../util.mjs";

const REASONS = {
  200: "OK", 201: "Created", 204: "No Content", 207: "Multi-Status", 301: "Moved Permanently",
  304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 409: "Conflict", 412: "Precondition Failed", 415: "Unsupported Media Type",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
};

const MAX_BODY = 50 * 1024 * 1024;

export class HttpSession {
  /**
   * @param {object} o
   * @param {object} o.conn     { write(bin), close() }
   * @param {Function} o.handler async (req) -> { status, headers, body }
   */
  constructor({ conn, handler, log = null }) {
    this.conn = conn;
    this.handler = handler;
    this.log = log;
    this.buffer = "";
    this.queue = Promise.resolve();
    this.closed = false;
  }

  data(bin) {
    this.buffer += bin;
    this.queue = this.queue.then(() => this.#drain()).catch(e => {
      this.log?.error(`HTTP: ${e.stack || e.message}`);
      this.#respond({ status: 500, body: e.message }, false);
      this.close();
    });
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      try {
        this.conn.close();
      } catch {}
    }
  }

  async #drain() {
    while (!this.closed) {
      const req = this.#parse();
      if (!req) {
        return;
      }
      const keepAlive = (req.headers.connection || "").toLowerCase() != "close";
      let res;
      try {
        res = await this.handler(req);
      } catch (e) {
        this.log?.error(`HTTP handler: ${e.stack || e.message}`);
        res = { status: 500, headers: { "Content-Type": "text/plain" }, body: e.message };
      }
      this.#respond(res, keepAlive, req.method == "HEAD");
      if (!keepAlive) {
        this.close();
      }
    }
  }

  #parse() {
    const end = this.buffer.indexOf("\r\n\r\n");
    if (end < 0) {
      if (this.buffer.length > 64 * 1024) {
        throw new Error("Request header too large");
      }
      return null;
    }
    const head = this.buffer.slice(0, end).split("\r\n");
    const [method, target] = head[0].split(" ");
    const headers = {};
    for (const line of head.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) {
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
    }
    let bodyStart = end + 4;
    let body = "";
    if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
      let pos = bodyStart;
      const chunks = [];
      for (;;) {
        const nl = this.buffer.indexOf("\r\n", pos);
        if (nl < 0) {
          return null;
        }
        const size = parseInt(this.buffer.slice(pos, nl).split(";")[0], 16);
        if (!Number.isFinite(size)) {
          throw new Error("Bad chunk size");
        }
        if (size == 0) {
          const trailerEnd = this.buffer.indexOf("\r\n", nl + 2);
          if (trailerEnd < 0) {
            return null;
          }
          pos = trailerEnd + 2;
          break;
        }
        if (this.buffer.length < nl + 2 + size + 2) {
          return null;
        }
        chunks.push(this.buffer.slice(nl + 2, nl + 2 + size));
        pos = nl + 2 + size + 2;
      }
      body = chunks.join("");
      this.buffer = this.buffer.slice(pos);
    } else {
      const len = parseInt(headers["content-length"] || "0", 10);
      if (len > MAX_BODY) {
        throw new Error("Request body too large");
      }
      if (this.buffer.length < bodyStart + len) {
        return null;
      }
      body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
    }
    let path = target || "/";
    let query = "";
    const q = path.indexOf("?");
    if (q >= 0) {
      query = path.slice(q + 1);
      path = path.slice(0, q);
    }
    if (/^https?:\/\//i.test(path)) {
      path = path.replace(/^https?:\/\/[^/]+/i, "") || "/";
    }
    return { method: (method || "").toUpperCase(), path, query, headers, body };
  }

  #respond(res, keepAlive, headOnly = false) {
    if (this.closed) {
      return;
    }
    // Bodies are Unicode text unless the handler marks them as binary strings.
    let body = res.body ?? "";
    if (!res.binary) {
      body = utf8Encode(body);
    }
    const headers = { ...(res.headers || {}) };
    headers["Content-Length"] = String(body.length);
    headers.Connection = keepAlive ? "keep-alive" : "close";
    headers.Server = "EWSBridge";
    let out = `HTTP/1.1 ${res.status} ${REASONS[res.status] || "Status"}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null) {
        out += `${k}: ${v}\r\n`;
      }
    }
    out += "\r\n";
    this.conn.write(out + (headOnly ? "" : body));
  }
}

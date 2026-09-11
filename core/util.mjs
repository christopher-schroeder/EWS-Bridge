/* EWS Bridge — shared helpers.
 *
 * Byte data is carried through the gateway as "binary strings": JS strings in
 * which every char code is one byte (0..255). This keeps line-oriented protocol
 * code (IMAP, SMTP, HTTP) simple while preserving 8-bit message content.
 */

export function bytesToBinary(bytes) {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function binaryToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Unicode string -> UTF-8 binary string. */
export function utf8Encode(str) {
  return bytesToBinary(encoder.encode(str));
}

/** UTF-8 binary string -> Unicode string (invalid sequences become U+FFFD). */
export function utf8Decode(bin) {
  return decoder.decode(binaryToBytes(bin));
}

export function isAscii(str) {
  return !/[^\x00-\x7f]/.test(str);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < B64.length; i++) {
  B64_LOOKUP[B64.charCodeAt(i)] = i;
}
B64_LOOKUP["-".charCodeAt(0)] = 62; // tolerate base64url
B64_LOOKUP["_".charCodeAt(0)] = 63;

/** Binary string -> base64. */
export function base64Encode(bin) {
  const parts = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < bin.length; i += 3) {
    const n = (bin.charCodeAt(i) << 16) | (bin.charCodeAt(i + 1) << 8) | bin.charCodeAt(i + 2);
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    if (chunk.length > 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = bin.length - i;
  if (rest == 1) {
    const n = bin.charCodeAt(i) << 16;
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + "==";
  } else if (rest == 2) {
    const n = (bin.charCodeAt(i) << 16) | (bin.charCodeAt(i + 1) << 8);
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

/** base64 (whitespace and missing padding tolerated) -> binary string. */
export function base64Decode(b64) {
  const out = [];
  let chunk = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i) & 0xff];
    if (v < 0) {
      continue; // whitespace, padding, garbage
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      chunk += String.fromCharCode((acc >> bits) & 0xff);
      if (chunk.length > 8192) {
        out.push(chunk);
        chunk = "";
      }
    }
  }
  out.push(chunk);
  return out.join("");
}

/** Wrap base64 at 76 columns, CRLF-terminated lines. */
export function base64Wrapped(bin) {
  const b64 = base64Encode(bin);
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/** Random alphanumeric token (uses crypto.getRandomValues where available). */
export function randomToken(length = 32) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

/**
 * Serialises async work per key: work for the same key runs strictly in
 * order, work for different keys runs concurrently.
 */
export class KeyedMutex {
  #tails = new Map();

  run(key, fn) {
    const prev = this.#tails.get(key) || Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => {});
    this.#tails.set(key, tail);
    tail.then(() => {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    });
    return result;
  }
}

/** Minimal leveled logger; the platform supplies the sink. */
export class Logger {
  static LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

  constructor(sink = null, level = "info", prefix = "") {
    this.sink = sink || ((lvl, msg) => console.log(`[${lvl}] ${msg}`));
    this.level = level;
    this.prefix = prefix;
  }

  child(prefix) {
    const c = new Logger(this.sink, this.level, this.prefix + prefix);
    c.parent = this;
    return c;
  }

  #enabled(lvl) {
    const root = this.parent ? this.#rootLevel() : this.level;
    return Logger.LEVELS[lvl] <= Logger.LEVELS[root];
  }

  #rootLevel() {
    let l = this;
    while (l.parent) {
      l = l.parent;
    }
    return l.level;
  }

  #emit(lvl, args) {
    if (!this.#enabled(lvl)) {
      return;
    }
    const msg = args
      .map(a => (a instanceof Error ? `${a.message}${a.stack ? "\n" + a.stack : ""}` : typeof a == "string" ? a : safeJson(a)))
      .join(" ");
    this.sink(lvl, this.prefix + msg);
  }

  error(...a) { this.#emit("error", a); }
  warn(...a) { this.#emit("warn", a); }
  info(...a) { this.#emit("info", a); }
  debug(...a) { this.#emit("debug", a); }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Remove password-like material from strings destined for logs. */
export function redact(str) {
  return String(str)
    .replace(/(Authorization:\s*\S+\s+)\S+/gi, "$1[redacted]")
    .replace(/(AUTHENTICATE PLAIN\s+)\S+/gi, "$1[redacted]")
    .replace(/(LOGIN\s+\S+\s+)\S+/gi, "$1[redacted]");
}

export function sleep(ms, setTimeoutFn = globalThis.setTimeout) {
  return new Promise(resolve => setTimeoutFn(resolve, ms));
}

/** Simple string hash (FNV-1a 32-bit), for stable file names. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

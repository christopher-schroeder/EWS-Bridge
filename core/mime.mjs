/* EWS Bridge — MIME parsing and formatting.
 *
 * All message data are binary strings (see util.mjs). Header values returned
 * by these functions are still raw (8-bit / RFC 2047 encoded) unless a
 * function says it decodes them.
 */

import { base64Decode, base64Encode, binaryToBytes, isAscii, utf8Decode, utf8Encode } from "./util.mjs";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Offset of the blank line separating header and body, and the body start. */
export function findHeaderEnd(bin, start = 0, end = bin.length) {
  // A body may begin immediately if the part has no headers at all.
  if (bin.startsWith("\r\n", start)) {
    return { headerEnd: start, bodyStart: start + 2 };
  }
  if (bin[start] == "\n") {
    return { headerEnd: start, bodyStart: start + 1 };
  }
  let i = start;
  while (i < end) {
    const nl = bin.indexOf("\n", i);
    if (nl < 0 || nl >= end) {
      return { headerEnd: end, bodyStart: end };
    }
    const next = nl + 1;
    if (bin.startsWith("\r\n", next)) {
      return { headerEnd: next, bodyStart: Math.min(next + 2, end) };
    }
    if (bin[next] == "\n") {
      return { headerEnd: next, bodyStart: Math.min(next + 1, end) };
    }
    i = next;
  }
  return { headerEnd: end, bodyStart: end };
}

/**
 * Parse a header block into [[name, rawValue], ...] with folding removed.
 * Names keep their original case.
 */
export function parseHeaderBlock(block) {
  const out = [];
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      continue;
    }
    if ((line[0] == " " || line[0] == "\t") && out.length) {
      out[out.length - 1][1] += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return out;
}

export class Headers {
  constructor(list = []) {
    this.list = list;
  }

  static parse(block) {
    return new Headers(parseHeaderBlock(block));
  }

  get(name) {
    const n = name.toLowerCase();
    for (const [k, v] of this.list) {
      if (k.toLowerCase() == n) {
        return v;
      }
    }
    return null;
  }

  getAll(name) {
    const n = name.toLowerCase();
    return this.list.filter(([k]) => k.toLowerCase() == n).map(([, v]) => v);
  }

  has(name) {
    return this.get(name) !== null;
  }
}

/**
 * Parse a structured header value like a Content-Type:
 * "text/plain; charset=utf-8; name*=utf-8''x" -> { value: "text/plain", params: {charset: "utf-8", ...} }
 * Parameter names are lower-cased; RFC 2231 continuations are merged and
 * decoded into `params`, while `rawParams` keeps the on-the-wire form.
 */
export function parseParamHeader(value) {
  const result = { value: "", params: {}, rawParams: [] };
  if (!value) {
    return result;
  }
  const tokens = splitParams(value);
  result.value = (tokens.shift() || "").trim();
  const continuations = {};
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    result.rawParams.push([name, v]);
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(name);
    if (m) {
      const base = m[1].toLowerCase();
      const idx = m[2] === undefined ? 0 : parseInt(m[2], 10);
      (continuations[base] ||= []).push({ idx, v, encoded: !!m[3] || (m[2] === undefined && name.endsWith("*")) });
    } else {
      result.params[name.toLowerCase()] = v;
    }
  }
  for (const [base, parts] of Object.entries(continuations)) {
    parts.sort((a, b) => a.idx - b.idx);
    let charset = "utf-8";
    let bin = "";
    parts.forEach((p, i) => {
      let v = p.v;
      if (p.encoded) {
        if (i == 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (m) {
            charset = m[1] || charset;
            v = m[2];
          }
        }
        v = v.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      }
      bin += v;
    });
    result.params[base] = decodeCharset(bin, charset);
  }
  return result;
}

function splitParams(value) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inQuote) {
      cur += c;
      if (c == "\\" && i + 1 < value.length) {
        cur += value[++i];
      } else if (c == '"') {
        inQuote = false;
      }
    } else if (c == '"') {
      inQuote = true;
      cur += c;
    } else if (c == ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.filter((t, i) => i == 0 || t.trim());
}

/** Decode bytes in a named charset to Unicode (falls back to latin1). */
export function decodeCharset(bin, charset = "utf-8") {
  const cs = (charset || "utf-8").toLowerCase();
  if (cs == "utf-8" || cs == "utf8" || cs == "us-ascii" || cs == "ascii") {
    return utf8Decode(bin);
  }
  try {
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return bin; // latin1 interpretation
  }
}

/** Decode RFC 2047 encoded-words (and raw UTF-8) in a header value. */
export function decodeHeaderValue(raw) {
  if (!raw) {
    return "";
  }
  // Raw 8-bit header bytes are usually UTF-8; strings that are already
  // Unicode (or not valid UTF-8) are kept as they are.
  let s = raw;
  if (!isAscii(raw) && !/[^\x00-\xff]/.test(raw)) {
    try {
      s = strictUtf8.decode(binaryToBytes(raw));
    } catch {
      s = raw;
    }
  }
  // Whitespace between adjacent encoded-words is dropped.
  s = s.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, "$1");
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (m, charset, enc, text) => {
    charset = charset.replace(/\*.*$/, ""); // strip RFC 2231 language
    let bin;
    if (enc.toUpperCase() == "B") {
      bin = base64Decode(text);
    } else {
      bin = text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return decodeCharset(bin, charset);
  });
}

/**
 * Encode a Unicode header value for the wire. ASCII text is left alone;
 * otherwise encoded-words are produced for each non-ASCII word run.
 */
export function encodeHeaderValue(str) {
  if (str === null || str === undefined) {
    return "";
  }
  str = String(str).replace(/[\r\n]+/g, " ");
  if (isAscii(str)) {
    return str;
  }
  // Encode the whole value as a sequence of B-encoded words (<= 75 chars each),
  // never splitting a UTF-8 sequence.
  const words = [];
  let chunk = "";
  for (const ch of str) {
    const test = chunk + ch;
    if (base64Encode(utf8Encode(test)).length > 60) {
      words.push(chunk);
      chunk = ch;
    } else {
      chunk = test;
    }
  }
  if (chunk) {
    words.push(chunk);
  }
  return words.map(w => `=?UTF-8?B?${base64Encode(utf8Encode(w))}?=`).join(" ");
}

/** Format one address for a header. name/email are Unicode. */
export function formatAddress({ name, email }) {
  email = (email || "").trim();
  if (!name || name == email) {
    return email.includes("@") ? email : `<${email}>`;
  }
  let n;
  if (!isAscii(name)) {
    n = encodeHeaderValue(name);
  } else if (/[()<>\[\]:;@\\,."]/.test(name)) {
    n = `"${name.replace(/(["\\])/g, "\\$1")}"`;
  } else {
    n = name;
  }
  return `${n} <${email}>`;
}

export function formatAddressList(list) {
  return (list || []).map(formatAddress).join(", ");
}

/**
 * Parse an address-list header (raw or decoded) into
 * [{name, email, group?}], flattening groups. Tolerant of garbage.
 */
export function parseAddressList(value) {
  const out = [];
  if (!value) {
    return out;
  }
  const s = decodeHeaderValue(value);
  let i = 0;
  let phrase = "";
  let addr = null;
  let group = null;

  const flush = () => {
    const p = phrase.trim().replace(/\s+/g, " ");
    if (addr !== null) {
      out.push({ name: unquote(p), email: addr.trim(), group });
    } else if (p) {
      // bare addr-spec, possibly old style "user@host (Name)"
      const m = /[^\s<>()]+@[^\s<>()]+/.exec(p);
      if (m) {
        const c = /\(([^)]*)\)/.exec(p);
        out.push({ name: c ? c[1] : "", email: m[0], group });
      } else if (p.includes("@") || !group) {
        out.push({ name: "", email: p, group });
      }
    }
    phrase = "";
    addr = null;
  };

  while (i < s.length) {
    const c = s[i];
    if (c == '"') {
      let j = i + 1;
      let q = "";
      while (j < s.length && s[j] != '"') {
        if (s[j] == "\\" && j + 1 < s.length) {
          j++;
        }
        q += s[j++];
      }
      phrase += `"${q}"`;
      i = j + 1;
    } else if (c == "(") {
      let depth = 1;
      let j = i + 1;
      let comment = "";
      while (j < s.length && depth > 0) {
        if (s[j] == "(") {
          depth++;
        } else if (s[j] == ")") {
          depth--;
        }
        if (depth > 0) {
          comment += s[j];
        }
        j++;
      }
      if (!phrase.trim() && addr === null) {
        // "(Comment) addr" — rare; ignore comment
      } else if (addr === null && !/[<]/.test(phrase)) {
        // "addr (Name)" old style: remember as name after flush
        phrase += ` (${comment})`;
      }
      i = j;
    } else if (c == "<") {
      const j = s.indexOf(">", i);
      addr = s.slice(i + 1, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j + 1;
    } else if (c == ":" && addr === null) {
      group = unquote(phrase.trim());
      phrase = "";
      i++;
    } else if (c == ";") {
      flush();
      group = null;
      i++;
    } else if (c == ",") {
      flush();
      i++;
    } else {
      phrase += c;
      i++;
    }
  }
  flush();
  // Old style "user@host (Name)"
  for (const a of out) {
    const m = /^(\S+@\S+)\s+\((.*)\)$/.exec(a.email);
    if (m) {
      a.email = m[1];
      a.name ||= m[2];
    }
    if (!a.name) {
      const m2 = /^(.*?)\s*\((.*)\)$/.exec(a.email);
      if (m2 && m2[1].includes("@")) {
        a.email = m2[1];
        a.name = m2[2];
      }
    }
  }
  return out.filter(a => a.email || a.name);
}

function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s.replace(/"/g, "");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = n => String(n).padStart(2, "0");

/** RFC 5322 date in UTC. */
export function formatRfc2822Date(date) {
  const d = new Date(date);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +0000`;
}

/** IMAP INTERNALDATE: "10-Sep-2026 12:34:56 +0000" */
export function formatImapDate(date) {
  const d = new Date(date);
  return `${pad2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes()
  )}:${pad2(d.getUTCSeconds())} +0000`;
}

/** Parse IMAP search date "1-Feb-1994" to a UTC midnight Date. */
export function parseImapSearchDate(s) {
  const m = /^"?(\d{1,2})-([A-Za-z]{3})-(\d{4})"?$/.exec(s);
  if (!m) {
    return null;
  }
  const mon = MONTHS.findIndex(x => x.toLowerCase() == m[2].toLowerCase());
  if (mon < 0) {
    return null;
  }
  return new Date(Date.UTC(parseInt(m[3], 10), mon, parseInt(m[1], 10)));
}

/** Parse an IMAP date-time "dd-Mon-yyyy hh:mm:ss +zzzz". */
export function parseImapDateTime(s) {
  const m = /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)$/.exec(s.trim());
  if (!m) {
    return null;
  }
  const mon = MONTHS.findIndex(x => x.toLowerCase() == m[2].toLowerCase());
  const utc = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]);
  const off = (m[7] == "-" ? -1 : 1) * (+m[8] * 60 + +m[9]);
  return new Date(utc - off * 60000);
}

// ---------------------------------------------------------------------------
// MIME tree

/**
 * Parse a MIME entity located at bin[start, end).
 * Returns a node:
 *   { start, headerEnd, bodyStart, end, headers, type, subtype, params,
 *     rawParams, children: [] (multipart), message: node (message/rfc822) }
 */
export function parseMime(bin, start = 0, end = bin.length, defaultType = "text/plain", depth = 0) {
  const { headerEnd, bodyStart } = findHeaderEnd(bin, start, end);
  const headers = Headers.parse(bin.slice(start, headerEnd));
  const ctRaw = headers.get("Content-Type");
  const ct = parseParamHeader(ctRaw || defaultType);
  let [type, subtype] = ct.value.toLowerCase().split("/");
  if (!type || !subtype) {
    [type, subtype] = defaultType.split("/");
  }
  const node = {
    start,
    headerEnd,
    bodyStart,
    end,
    headers,
    type,
    subtype,
    params: ct.params,
    rawParams: ctRaw ? ct.rawParams : [["charset", "us-ascii"]],
    children: [],
    message: null,
  };
  if (depth > 40) {
    return node; // pathological nesting
  }
  if (type == "multipart" && ct.params.boundary) {
    node.children = parseMultipart(bin, bodyStart, end, ct.params.boundary, subtype == "digest" ? "message/rfc822" : "text/plain", depth);
  } else if (type == "message" && (subtype == "rfc822" || subtype == "global")) {
    const enc = (headers.get("Content-Transfer-Encoding") || "7bit").toLowerCase();
    if (enc != "base64" && enc != "quoted-printable") {
      node.message = parseMime(bin, bodyStart, end, "text/plain", depth + 1);
    }
  }
  return node;
}

function parseMultipart(bin, start, end, boundary, childDefault, depth) {
  const delim = "--" + boundary;
  const parts = [];
  // Find delimiter lines: at start of body or after a newline.
  const positions = [];
  let i = start;
  while (i < end) {
    const idx = bin.indexOf(delim, i);
    if (idx < 0 || idx >= end) {
      break;
    }
    const atLineStart = idx == start || bin[idx - 1] == "\n";
    if (atLineStart) {
      const after = idx + delim.length;
      const isClose = bin.startsWith("--", after);
      // Delimiter line must be followed by optional whitespace and a newline.
      let lineEnd = bin.indexOf("\n", after);
      if (lineEnd < 0 || lineEnd > end) {
        lineEnd = end;
      }
      // the part content ends before the CRLF preceding the delimiter
      let contentEnd = idx;
      if (contentEnd > start && bin[contentEnd - 1] == "\n") {
        contentEnd--;
        if (contentEnd > start && bin[contentEnd - 1] == "\r") {
          contentEnd--;
        }
      }
      positions.push({ contentEnd, next: Math.min(lineEnd + 1, end), isClose });
      if (isClose) {
        break;
      }
      i = lineEnd + 1;
    } else {
      i = idx + delim.length;
    }
  }
  for (let p = 0; p < positions.length - 1; p++) {
    const partStart = positions[p].next;
    const partEnd = positions[p + 1].contentEnd;
    if (partEnd >= partStart) {
      parts.push(parseMime(bin, partStart, partEnd, childDefault, depth + 1));
    }
  }
  // Unterminated multipart: last part runs to end.
  if (positions.length && !positions[positions.length - 1].isClose) {
    const partStart = positions[positions.length - 1].next;
    if (partStart < end) {
      parts.push(parseMime(bin, partStart, end, childDefault, depth + 1));
    }
  }
  return parts;
}

/**
 * Resolve an IMAP section part path (array of numbers) to a node.
 * `root` is the top-level message node. Returns null if absent.
 */
export function resolvePart(root, path) {
  let node = root;
  let isMessage = true; // node is a message (root or encapsulated)
  for (const n of path) {
    if (isMessage) {
      if (node.type == "multipart") {
        node = node.children[n - 1];
      } else if (n == 1) {
        node = { ...node, virtualBody: true };
      } else {
        return null;
      }
    } else if (node.type == "multipart") {
      node = node.children[n - 1];
    } else if (node.message) {
      const m = node.message;
      if (m.type == "multipart") {
        node = m.children[n - 1];
      } else if (n == 1) {
        node = { ...m, virtualBody: true };
      } else {
        return null;
      }
    } else {
      return null;
    }
    if (!node) {
      return null;
    }
    isMessage = false;
  }
  return node;
}

/** The message node whose HEADER/TEXT a section refers to. */
export function messageNodeFor(root, path) {
  if (!path.length) {
    return root;
  }
  const node = resolvePart(root, path);
  return node && node.message ? node.message : null;
}

function countLines(bin, start, end) {
  let n = 0;
  for (let i = bin.indexOf("\n", start); i >= 0 && i < end; i = bin.indexOf("\n", i + 1)) {
    n++;
  }
  // count a final unterminated line
  if (end > start && bin[end - 1] != "\n") {
    n++;
  }
  return n;
}

/**
 * IMAP BODYSTRUCTURE for a parsed message. `q` quotes an IMAP string/NIL.
 */
export function bodyStructure(bin, root, q, extended = true) {
  return structureOf(bin, root, q, extended);
}

function structureOf(bin, node, q, ext) {
  const nstring = v => (v === null || v === undefined || v === "" ? "NIL" : q(v));
  const paramList = raw => {
    if (!raw || !raw.length) {
      return "NIL";
    }
    return "(" + raw.map(([k, v]) => `${q(k.toUpperCase())} ${q(v)}`).join(" ") + ")";
  };
  const disposition = () => {
    const d = node.headers.get("Content-Disposition");
    if (!d) {
      return "NIL";
    }
    const p = parseParamHeader(d);
    return `(${q(p.value.toUpperCase() || "ATTACHMENT")} ${paramList(p.rawParams)})`;
  };
  const language = () => nstring(node.headers.get("Content-Language"));
  const location = () => nstring(node.headers.get("Content-Location"));

  if (node.type == "multipart") {
    const kids = node.children.length
      ? node.children.map(c => structureOf(bin, c, q, ext)).join("")
      : `("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 0 0)`;
    let s = `(${kids} ${q(node.subtype.toUpperCase())}`;
    if (ext) {
      s += ` ${paramList(node.rawParams)} ${disposition()} ${language()} ${location()}`;
    }
    return s + ")";
  }
  const size = node.end - node.bodyStart;
  const enc = (node.headers.get("Content-Transfer-Encoding") || "7BIT").toUpperCase();
  let s =
    `(${q(node.type.toUpperCase())} ${q(node.subtype.toUpperCase())} ${paramList(node.rawParams)} ` +
    `${nstring(node.headers.get("Content-ID"))} ${nstring(node.headers.get("Content-Description"))} ` +
    `${q(enc)} ${size}`;
  if (node.message) {
    s += ` ${envelope(node.message.headers, q)} ${structureOf(bin, node.message, q, ext)} ${countLines(bin, node.bodyStart, node.end)}`;
  } else if (node.type == "text") {
    s += ` ${countLines(bin, node.bodyStart, node.end)}`;
  }
  if (ext) {
    s += ` ${nstring(node.headers.get("Content-MD5"))} ${disposition()} ${language()} ${location()}`;
  }
  return s + ")";
}

/** IMAP ENVELOPE from a Headers object. */
export function envelope(headers, q) {
  const nstring = v => (v === null || v === undefined ? "NIL" : q(v));
  const addrs = name => {
    const v = headers.get(name);
    if (!v) {
      return null;
    }
    const list = parseAddressList(v);
    if (!list.length) {
      return null;
    }
    return (
      "(" +
      list
        .map(a => {
          const at = a.email.lastIndexOf("@");
          const mailbox = at < 0 ? a.email : a.email.slice(0, at);
          const host = at < 0 ? "" : a.email.slice(at + 1);
          return `(${a.name ? q(encodeHeaderValue(a.name)) : "NIL"} NIL ${q(mailbox)} ${host ? q(host) : "NIL"})`;
        })
        .join("") +
      ")"
    );
  };
  const from = addrs("From");
  const sender = addrs("Sender") || from;
  const replyTo = addrs("Reply-To") || from;
  return (
    `(${nstring(headers.get("Date"))} ${nstring(headers.get("Subject"))} ${from || "NIL"} ${sender || "NIL"} ` +
    `${replyTo || "NIL"} ${addrs("To") || "NIL"} ${addrs("Cc") || "NIL"} ${addrs("Bcc") || "NIL"} ` +
    `${nstring(headers.get("In-Reply-To"))} ${nstring(headers.get("Message-ID"))})`
  );
}

/** Decode a part body according to its Content-Transfer-Encoding. */
export function decodeTransfer(bin, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "base64":
      return base64Decode(bin);
    case "quoted-printable":
      return bin.replace(/=\r?\n/g, "").replace(/=([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    default:
      return bin;
  }
}

/** Text of the first text/plain (or stripped text/html) part, Unicode. */
export function extractText(bin, node = parseMime(bin)) {
  const plain = findPart(node, n => n.type == "text" && n.subtype == "plain" && !isAttachment(n));
  const html = plain ? null : findPart(node, n => n.type == "text" && n.subtype == "html" && !isAttachment(n));
  const part = plain || html;
  if (!part) {
    return "";
  }
  const raw = decodeTransfer(bin.slice(part.bodyStart, part.end), part.headers.get("Content-Transfer-Encoding"));
  let text = decodeCharset(raw, part.params.charset || "utf-8");
  if (html) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return text;
}

function isAttachment(node) {
  const d = node.headers.get("Content-Disposition");
  return d ? parseParamHeader(d).value.toLowerCase() == "attachment" : false;
}

function findPart(node, pred) {
  if (pred(node)) {
    return node;
  }
  for (const c of node.children) {
    const r = findPart(c, pred);
    if (r) {
      return r;
    }
  }
  return null;
}

/** Split a message into its header block string and the rest. */
export function splitMessage(bin) {
  const { headerEnd, bodyStart } = findHeaderEnd(bin);
  return { header: bin.slice(0, headerEnd), body: bin.slice(bodyStart) };
}

/**
 * Insert or replace a header at the top of a message (raw value, already
 * encoded). Existing headers of that name are removed.
 */
export function setHeader(bin, name, value) {
  const { headerEnd } = findHeaderEnd(bin);
  const header = bin.slice(0, headerEnd);
  const lines = header.split(/\r?\n/);
  const kept = [];
  const lname = name.toLowerCase();
  let skipping = false;
  for (const line of lines) {
    if (line == "") {
      continue;
    }
    if ((line[0] == " " || line[0] == "\t") && skipping) {
      continue;
    }
    skipping = line.toLowerCase().startsWith(lname + ":");
    if (!skipping) {
      kept.push(line);
    }
  }
  if (value !== null) {
    kept.push(`${name}: ${value}`);
  }
  return kept.join("\r\n") + "\r\n" + bin.slice(headerEnd);
}

/** Normalise bare LF line endings to CRLF. */
export function toCRLF(bin) {
  return bin.replace(/\r?\n/g, "\r\n");
}

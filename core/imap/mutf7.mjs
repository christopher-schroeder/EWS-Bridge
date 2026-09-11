/* IMAP modified UTF-7 mailbox name encoding (RFC 3501 §5.1.3). */

import { base64Encode, base64Decode } from "../util.mjs";

export function encodeMUTF7(str) {
  let out = "";
  let buf = "";
  const flush = () => {
    if (!buf) {
      return;
    }
    // UTF-16BE bytes as binary string
    let bin = "";
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      bin += String.fromCharCode(c >> 8, c & 0xff);
    }
    out += "&" + base64Encode(bin).replace(/=+$/, "").replace(/\//g, ",") + "-";
    buf = "";
  };
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch == "&" ? "&-" : ch;
    } else {
      buf += ch; // may be a surrogate pair; kept as two UTF-16 units
    }
  }
  flush();
  return out;
}

export function decodeMUTF7(str) {
  return str.replace(/&([^-]*)-/g, (m, b64) => {
    if (!b64) {
      return "&";
    }
    const bin = base64Decode(b64.replace(/,/g, "/"));
    let s = "";
    for (let i = 0; i + 1 < bin.length; i += 2) {
      s += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    }
    return s;
  });
}

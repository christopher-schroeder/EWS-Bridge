/* EWS Bridge — IMAP wire format: command reader, tokenizer, formatting. */

/**
 * Accumulates bytes and yields complete commands. A command is returned as a
 * list of segments: strings (line text) and { literal } objects.
 */
export class CommandReader {
  constructor({ onCommand, onContinuationNeeded, onLine, maxLiteral = 200 * 1024 * 1024 }) {
    this.buffer = "";
    this.parts = [];
    this.awaitLiteral = 0;
    this.onCommand = onCommand;
    this.onContinuationNeeded = onContinuationNeeded;
    this.onLine = onLine; // raw line consumer (IDLE DONE, AUTHENTICATE); returns true if consumed
    this.maxLiteral = maxLiteral;
  }

  feed(bin) {
    this.buffer += bin;
    for (;;) {
      if (this.awaitLiteral) {
        if (this.buffer.length < this.awaitLiteral) {
          return;
        }
        this.parts.push({ literal: this.buffer.slice(0, this.awaitLiteral) });
        this.buffer = this.buffer.slice(this.awaitLiteral);
        this.awaitLiteral = 0;
        continue;
      }
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) {
        if (this.buffer.length > 1024 * 1024) {
          throw new Error("Command line too long");
        }
        return;
      }
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (!this.parts.length && this.onLine && this.onLine(line)) {
        continue;
      }
      const m = /\{(\d+)(\+?)\}$/.exec(line);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > this.maxLiteral) {
          throw new Error("Literal too large");
        }
        this.parts.push(line.slice(0, m.index));
        this.awaitLiteral = n;
        if (!m[2]) {
          this.onContinuationNeeded();
        }
        if (n == 0) {
          this.parts.push({ literal: "" });
          this.awaitLiteral = 0;
        }
        continue;
      }
      this.parts.push(line);
      const parts = this.parts;
      this.parts = [];
      this.onCommand(parts);
    }
  }
}

export class ParseError extends Error {}

/**
 * Tokenize command segments into values:
 *   string (atom), { s: string } (quoted/literal), array (parenthesised list)
 */
export function tokenize(parts) {
  const out = [];
  const stack = [out];
  let cur = out;
  for (const part of parts) {
    if (typeof part != "string") {
      cur.push({ s: part.literal });
      continue;
    }
    let i = 0;
    const s = part;
    while (i < s.length) {
      const c = s[i];
      if (c == " ") {
        i++;
      } else if (c == "(") {
        const list = [];
        cur.push(list);
        stack.push(list);
        cur = list;
        i++;
      } else if (c == ")") {
        stack.pop();
        if (!stack.length) {
          throw new ParseError("Unbalanced parenthesis");
        }
        cur = stack[stack.length - 1];
        i++;
      } else if (c == '"') {
        let v = "";
        i++;
        while (i < s.length && s[i] != '"') {
          if (s[i] == "\\" && i + 1 < s.length) {
            i++;
          }
          v += s[i++];
        }
        if (i >= s.length) {
          throw new ParseError("Unterminated quoted string");
        }
        i++;
        cur.push({ s: v });
      } else {
        let v = "";
        while (i < s.length && s[i] != " " && s[i] != "(" && s[i] != ")" && s[i] != '"') {
          if (s[i] == "[") {
            const end = s.indexOf("]", i);
            if (end < 0) {
              throw new ParseError("Unterminated [");
            }
            v += s.slice(i, end + 1);
            i = end + 1;
            continue;
          }
          v += s[i++];
        }
        cur.push(v);
      }
    }
  }
  if (stack.length != 1) {
    throw new ParseError("Unbalanced parenthesis");
  }
  return out;
}

/** String value of an astring token (atom or quoted/literal). */
export function astr(tok) {
  if (tok === undefined || tok === null) {
    throw new ParseError("Missing argument");
  }
  if (typeof tok == "string") {
    return tok;
  }
  if (Array.isArray(tok)) {
    throw new ParseError("Unexpected list");
  }
  return tok.s;
}

/** Quote for output (binary string content). */
export function quote(s) {
  if (s === null || s === undefined) {
    return "NIL";
  }
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s) && s.length < 1000) {
    return `"${s.replace(/(["\\])/g, "\\$1")}"`;
  }
  return `{${s.length}}\r\n${s}`;
}

/**
 * Parse a sequence set ("1:4,7,9:*") against a maximum value.
 * Returns a predicate-friendly list of [lo, hi] ranges.
 */
export function parseSequenceSet(str, max) {
  const ranges = [];
  for (const piece of str.split(",")) {
    if (!piece) {
      throw new ParseError("Bad sequence set");
    }
    const [a, b] = piece.split(":");
    const val = x => {
      if (x == "*") {
        return max;
      }
      if (!/^\d+$/.test(x)) {
        throw new ParseError(`Bad sequence number ${x}`);
      }
      return parseInt(x, 10);
    };
    let lo = val(a);
    let hi = b === undefined ? lo : val(b);
    if (lo > hi) {
      [lo, hi] = [hi, lo];
    }
    ranges.push([lo, hi]);
  }
  return ranges;
}

export function inRanges(ranges, n) {
  for (const [lo, hi] of ranges) {
    if (n >= lo && n <= hi) {
      return true;
    }
  }
  return false;
}

/** Compress sorted numbers into an IMAP set: [1,2,3,5] -> "1:3,5" */
export function formatSet(nums) {
  const out = [];
  let start = null;
  let prev = null;
  for (const n of nums) {
    if (start === null) {
      start = prev = n;
    } else if (n == prev + 1) {
      prev = n;
    } else {
      out.push(start == prev ? `${start}` : `${start}:${prev}`);
      start = prev = n;
    }
  }
  if (start !== null) {
    out.push(start == prev ? `${start}` : `${start}:${prev}`);
  }
  return out.join(",");
}

/** IMAP list-mailbox wildcard pattern -> RegExp. */
export function patternToRegExp(pattern, delimiter = "/") {
  let re = "";
  for (const ch of pattern) {
    if (ch == "*") {
      re += ".*";
    } else if (ch == "%") {
      re += `[^${delimiter.replace(/[\]\\^-]/g, "\\$&")}]*`;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

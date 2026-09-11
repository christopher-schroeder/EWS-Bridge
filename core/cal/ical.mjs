/* EWS Bridge — iCalendar (RFC 5545) and vCard (RFC 6350) line format.
 * Both share the content-line syntax, so one parser serves both.
 */

export class Component {
  constructor(name, props = [], components = []) {
    this.name = name.toUpperCase();
    this.props = props; // [{ name, params: {NAME: value}, value }]
    this.components = components;
  }

  get(name) {
    const n = name.toUpperCase();
    return this.props.find(p => p.name == n) || null;
  }

  getAll(name) {
    const n = name.toUpperCase();
    return this.props.filter(p => p.name == n);
  }

  value(name, def = null) {
    const p = this.get(name);
    return p ? p.value : def;
  }

  add(name, value, params = {}) {
    if (value === null || value === undefined || value === "") {
      return this;
    }
    this.props.push({ name: name.toUpperCase(), params, value: String(value) });
    return this;
  }

  set(name, value, params = {}) {
    this.remove(name);
    return this.add(name, value, params);
  }

  remove(name) {
    const n = name.toUpperCase();
    this.props = this.props.filter(p => p.name != n);
  }

  sub(name) {
    const n = name.toUpperCase();
    return this.components.filter(c => c.name == n);
  }
}

/** Unfold and split into logical lines. */
function unfold(text) {
  return text.replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "").split(/\r\n|\n|\r/);
}

function parseLine(line) {
  // name *(";" param) ":" value — params may be quoted and contain ':' or ';'
  let i = 0;
  let name = "";
  while (i < line.length && line[i] != ";" && line[i] != ":") {
    name += line[i++];
  }
  const params = {};
  while (line[i] == ";") {
    i++;
    let pname = "";
    while (i < line.length && line[i] != "=" && line[i] != ";" && line[i] != ":") {
      pname += line[i++];
    }
    const values = [];
    if (line[i] == "=") {
      i++;
      for (;;) {
        let v = "";
        if (line[i] == '"') {
          i++;
          while (i < line.length && line[i] != '"') {
            v += line[i++];
          }
          i++;
        } else {
          while (i < line.length && line[i] != "," && line[i] != ";" && line[i] != ":") {
            v += line[i++];
          }
        }
        values.push(v);
        if (line[i] == ",") {
          i++;
          continue;
        }
        break;
      }
    }
    params[pname.toUpperCase()] = values.length > 1 ? values : values[0] ?? "";
  }
  if (line[i] != ":") {
    return null;
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** Parse iCalendar/vCard text. Returns the top-level components. */
export function parseComponents(text) {
  const roots = [];
  const stack = [];
  for (const raw of unfold(text)) {
    if (!raw.trim()) {
      continue;
    }
    const p = parseLine(raw);
    if (!p) {
      continue;
    }
    if (p.name == "BEGIN") {
      const c = new Component(p.value.trim());
      if (stack.length) {
        stack[stack.length - 1].components.push(c);
      } else {
        roots.push(c);
      }
      stack.push(c);
    } else if (p.name == "END") {
      stack.pop();
    } else if (stack.length) {
      stack[stack.length - 1].props.push(p);
    }
  }
  return roots;
}

export function parseCalendar(text) {
  const roots = parseComponents(text);
  const cal = roots.find(c => c.name == "VCALENDAR");
  if (!cal) {
    throw new Error("Not an iCalendar object");
  }
  return cal;
}

function paramValue(v) {
  const s = Array.isArray(v) ? v : [v];
  return s.map(x => (/[;:,]/.test(x) ? `"${x.replace(/"/g, "'")}"` : x)).join(",");
}

/** Fold a content line to at most 75 octets (UTF-8), per RFC 5545 §3.1. */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) {
    return line;
  }
  const out = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function serialize(comp) {
  const lines = [`BEGIN:${comp.name}`];
  for (const p of comp.props) {
    let l = p.name;
    for (const [k, v] of Object.entries(p.params || {})) {
      l += `;${k}=${paramValue(v)}`;
    }
    lines.push(fold(`${l}:${p.value}`));
  }
  for (const c of comp.components) {
    lines.push(serialize(c).replace(/\r\n$/, ""));
  }
  lines.push(`END:${comp.name}`);
  return lines.join("\r\n") + "\r\n";
}

/** TEXT value escaping. */
export function escapeText(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function unescapeText(s) {
  return String(s ?? "").replace(/\\([\;,nN])/g, (_, c) => (c == "n" || c == "N" ? "\n" : c));
}

/** Split a list value on unescaped commas (CATEGORIES, EXDATE, ...). */
export function splitList(s) {
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] == "\\" && i + 1 < s.length) {
      cur += s[i] + s[i + 1];
      i++;
    } else if (s[i] == ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a DATE or DATE-TIME property value.
 * Returns { y, m, d, h, mi, s, utc: bool, date: bool, tzid: string|null }
 */
export function parseDateValue(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) {
    return null;
  }
  const isDate = m[4] === undefined || params.VALUE == "DATE";
  return {
    y: +m[1], m: +m[2], d: +m[3],
    h: isDate ? 0 : +m[4], mi: isDate ? 0 : +m[5], s: isDate ? 0 : +(m[6] || 0),
    utc: !!m[7],
    date: isDate,
    tzid: !m[7] && !isDate && params.TZID ? String(params.TZID).replace(/^\//, "") : null,
  };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function formatDate({ y, m, d }) {
  return `${pad(y, 4)}${pad(m)}${pad(d)}`;
}

export function formatDateTime({ y, m, d, h, mi, s }, utc = false) {
  return `${formatDate({ y, m, d })}T${pad(h)}${pad(mi)}${pad(s)}${utc ? "Z" : ""}`;
}

export function formatUtc(ms) {
  const d = new Date(ms);
  return formatDateTime({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }, true);
}

/** Parse an iCal DURATION into seconds (signed). */
export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) {
    return null;
  }
  const secs = (+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0);
  return m[1] == "-" ? -secs : secs;
}

export function formatDuration(secs) {
  const neg = secs < 0;
  secs = Math.abs(secs);
  const d = Math.floor(secs / 86400);
  secs -= d * 86400;
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const mi = Math.floor(secs / 60);
  const s = secs - mi * 60;
  let out = `${neg ? "-" : ""}P`;
  if (d) {
    out += `${d}D`;
  }
  if (h || mi || s || !d) {
    out += "T";
    if (h) {
      out += `${h}H`;
    }
    if (mi) {
      out += `${mi}M`;
    }
    if (s || (!h && !mi)) {
      out += `${s}S`;
    }
  }
  return out;
}

/* EWS Bridge — small XML parser and helpers.
 *
 * Parses well-formed XML (SOAP responses, WebDAV bodies) into a light tree.
 * Element and attribute names are reduced to their local part: EWS and DAV
 * disambiguate by structure, and servers are free to pick any prefix.
 */

export class XmlElement {
  constructor(name, attrs = {}, ns = "") {
    this.name = name; // local name
    this.ns = ns; // namespace URI if resolvable
    this.attrs = attrs; // localName -> value
    this.children = [];
    this.parent = null;
  }

  /** First direct child element with the given local name. */
  child(name) {
    for (const c of this.children) {
      if (c instanceof XmlElement && c.name == name) {
        return c;
      }
    }
    return null;
  }

  /** All direct child elements (optionally filtered by local name). */
  elements(name = null) {
    return this.children.filter(c => c instanceof XmlElement && (name === null || c.name == name));
  }

  /** Follow a path of local names: el.path("Body", "Fault"). */
  path(...names) {
    let el = this;
    for (const n of names) {
      el = el?.child(n);
      if (!el) {
        return null;
      }
    }
    return el;
  }

  /** Depth-first search for descendants with this local name. */
  findAll(name, out = []) {
    for (const c of this.children) {
      if (c instanceof XmlElement) {
        if (c.name == name) {
          out.push(c);
        }
        c.findAll(name, out);
      }
    }
    return out;
  }

  find(name) {
    for (const c of this.children) {
      if (c instanceof XmlElement) {
        if (c.name == name) {
          return c;
        }
        const r = c.find(name);
        if (r) {
          return r;
        }
      }
    }
    return null;
  }

  /** Concatenated text content of this element. */
  get text() {
    let s = "";
    for (const c of this.children) {
      s += typeof c == "string" ? c : c.text;
    }
    return s;
  }

  /** Text of a direct child, or `def` if missing. */
  childText(name, def = null) {
    const c = this.child(name);
    return c ? c.text : def;
  }

  attr(name, def = null) {
    return name in this.attrs ? this.attrs[name] : def;
  }
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf("&") < 0) {
    return s;
  }
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] == "#") {
      const code = e[1] == "x" || e[1] == "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function localName(qname) {
  const i = qname.indexOf(":");
  return i < 0 ? qname : qname.slice(i + 1);
}

function prefixOf(qname) {
  const i = qname.indexOf(":");
  return i < 0 ? "" : qname.slice(0, i);
}

export class XmlParseError extends Error {}

/**
 * Parse an XML document (Unicode string). Returns the root XmlElement.
 * Whitespace-only text nodes are dropped.
 */
export function parseXml(src) {
  let pos = 0;
  const len = src.length;
  const root = new XmlElement("#document");
  let cur = root;
  const nsStack = [{ xml: "http://www.w3.org/XML/1998/namespace" }];

  // Skip BOM
  if (src.charCodeAt(0) == 0xfeff) {
    pos = 1;
  }

  while (pos < len) {
    const lt = src.indexOf("<", pos);
    if (lt < 0) {
      addText(src.slice(pos));
      break;
    }
    if (lt > pos) {
      addText(src.slice(pos, lt));
    }
    pos = lt;
    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos + 4);
      if (end < 0) {
        throw new XmlParseError("Unterminated comment");
      }
      pos = end + 3;
    } else if (src.startsWith("<![CDATA[", pos)) {
      const end = src.indexOf("]]>", pos + 9);
      if (end < 0) {
        throw new XmlParseError("Unterminated CDATA");
      }
      cur.children.push(src.slice(pos + 9, end));
      pos = end + 3;
    } else if (src.startsWith("<?", pos)) {
      const end = src.indexOf("?>", pos + 2);
      if (end < 0) {
        throw new XmlParseError("Unterminated processing instruction");
      }
      pos = end + 2;
    } else if (src.startsWith("<!", pos)) {
      // DOCTYPE — skip, including an internal subset.
      let depth = 0;
      let i = pos + 2;
      for (; i < len; i++) {
        const ch = src[i];
        if (ch == "[") {
          depth++;
        } else if (ch == "]") {
          depth--;
        } else if (ch == ">" && depth <= 0) {
          break;
        }
      }
      pos = i + 1;
    } else if (src[pos + 1] == "/") {
      const end = src.indexOf(">", pos);
      if (end < 0) {
        throw new XmlParseError("Unterminated end tag");
      }
      const name = localName(src.slice(pos + 2, end).trim());
      if (cur === root || cur.name != name) {
        throw new XmlParseError(`Mismatched end tag </${name}> (open: <${cur.name}>)`);
      }
      cur = cur.parent;
      nsStack.pop();
      pos = end + 1;
    } else {
      pos = parseStartTag(pos);
    }
  }
  if (cur !== root) {
    throw new XmlParseError(`Unclosed element <${cur.name}>`);
  }
  const top = root.elements()[0];
  if (!top) {
    throw new XmlParseError("No root element");
  }
  top.parent = null;
  return top;

  function addText(t) {
    if (cur === root) {
      return;
    }
    if (/^\s*$/.test(t)) {
      return;
    }
    cur.children.push(decodeEntities(t));
  }

  function parseStartTag(start) {
    let i = start + 1;
    const nameStart = i;
    while (i < len && !/[\s/>]/.test(src[i])) {
      i++;
    }
    const qname = src.slice(nameStart, i);
    const rawAttrs = [];
    for (;;) {
      while (i < len && /\s/.test(src[i])) {
        i++;
      }
      if (i >= len) {
        throw new XmlParseError("Unterminated start tag");
      }
      if (src[i] == ">" || (src[i] == "/" && src[i + 1] == ">")) {
        break;
      }
      const an = i;
      while (i < len && !/[\s=/>]/.test(src[i])) {
        i++;
      }
      const aname = src.slice(an, i);
      while (i < len && /\s/.test(src[i])) {
        i++;
      }
      let value = "";
      if (src[i] == "=") {
        i++;
        while (i < len && /\s/.test(src[i])) {
          i++;
        }
        const q = src[i];
        if (q != '"' && q != "'") {
          throw new XmlParseError(`Unquoted attribute ${aname}`);
        }
        const vend = src.indexOf(q, i + 1);
        if (vend < 0) {
          throw new XmlParseError("Unterminated attribute value");
        }
        value = decodeEntities(src.slice(i + 1, vend));
        i = vend + 1;
      }
      rawAttrs.push([aname, value]);
    }
    const selfClosing = src[i] == "/";
    i += selfClosing ? 2 : 1;

    const scope = Object.create(nsStack[nsStack.length - 1]);
    const attrs = {};
    for (const [n, v] of rawAttrs) {
      if (n == "xmlns") {
        scope[""] = v;
      } else if (n.startsWith("xmlns:")) {
        scope[n.slice(6)] = v;
      } else {
        attrs[localName(n)] = v;
      }
    }
    const el = new XmlElement(localName(qname), attrs, scope[prefixOf(qname)] || "");
    el.parent = cur;
    cur.children.push(el);
    if (!selfClosing) {
      cur = el;
      nsStack.push(scope);
    }
    return i;
  }
}

/** Escape text for element content or attribute values. */
export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Characters not allowed in XML 1.0 at all:
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "");
}

/** Build `<tag attr="..">content</tag>`; content is NOT escaped (compose with esc()). */
export function tag(name, attrs, content) {
  if (typeof attrs == "string" || Array.isArray(attrs) || attrs === undefined) {
    content = attrs;
    attrs = null;
  }
  let a = "";
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) {
        a += ` ${k}="${xmlEscape(v)}"`;
      }
    }
  }
  if (Array.isArray(content)) {
    content = content.filter(c => c !== null && c !== undefined && c !== false).join("");
  }
  if (content === undefined || content === null || content === "") {
    return `<${name}${a}/>`;
  }
  return `<${name}${a}>${content}</${name}>`;
}

/** Element with escaped text content, omitted entirely when value is null/undefined. */
export function textTag(name, value, attrs = null) {
  if (value === null || value === undefined) {
    return "";
  }
  return tag(name, attrs, xmlEscape(value));
}

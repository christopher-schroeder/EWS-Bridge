/* EWS Bridge — WebDAV front end for CalDAV (RFC 4791) and CardDAV
 * (RFC 6352), serving the account's Exchange calendars and contact folders.
 *
 * URL layout (per account key):
 *   /principals/<key>/
 *   /calendars/<key>/            calendar home
 *   /calendars/<key>/<id>/       calendar collection
 *   /calendars/<key>/<id>/<x>.ics
 *   /addressbooks/<key>/...      same for contacts (.vcf)
 */

import { parseXml, xmlEscape } from "../xml.mjs";
import { base64Decode, utf8Decode } from "../util.mjs";
import { CalendarError } from "../cal/calendar.mjs";

const D = "DAV:";
const C = "urn:ietf:params:xml:ns:caldav";
const CS = "http://calendarserver.org/ns/";
const CR = "urn:ietf:params:xml:ns:carddav";
const ICAL = "http://apple.com/ns/ical/";
const PREFIX = { [D]: "d", [C]: "c", [CS]: "cs", [CR]: "card", [ICAL]: "ical" };
const NS_DECL = Object.entries(PREFIX).map(([ns, p]) => `xmlns:${p}="${ns}"`).join(" ");

const KIND = {
  calendar: { root: "calendars", ext: ".ics", mime: "text/calendar; charset=utf-8; component=vevent", dataProp: [C, "calendar-data"] },
  addressbook: { root: "addressbooks", ext: ".vcf", mime: "text/vcard; charset=utf-8", dataProp: [CR, "address-data"] },
};

function el(ns, name, inner = "") {
  const p = PREFIX[ns];
  if (p) {
    return inner === "" ? `<${p}:${name}/>` : `<${p}:${name}>${inner}</${p}:${name}>`;
  }
  return inner === "" ? `<x:${name} xmlns:x="${xmlEscape(ns)}"/>` : `<x:${name} xmlns:x="${xmlEscape(ns)}">${inner}</x:${name}>`;
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS_DECL}>${responses.join("")}</d:multistatus>`;
}

/** One <d:response> given requested props and a value lookup. */
function propResponse(href, requested, values) {
  const found = [];
  const missing = [];
  for (const [ns, name] of requested) {
    const v = values(ns, name);
    if (v === undefined || v === null) {
      missing.push(el(ns, name));
    } else {
      found.push(el(ns, name, v));
    }
  }
  let out = `<d:response><d:href>${xmlEscape(href)}</d:href>`;
  if (found.length) {
    out += `<d:propstat><d:prop>${found.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
  }
  if (missing.length) {
    out += `<d:propstat><d:prop>${missing.join("")}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`;
  }
  return out + "</d:response>";
}

function requestedProps(body, defaults) {
  if (!body || !body.trim()) {
    return defaults;
  }
  let doc;
  try {
    doc = parseXml(body);
  } catch {
    return defaults;
  }
  const prop = doc.child("prop");
  if (!prop) {
    return defaults; // allprop / propname
  }
  return prop.elements().map(e => [e.ns, e.name]);
}

const xmlResponse = (status, body, extra = {}) => ({ status, headers: { "Content-Type": 'application/xml; charset="utf-8"', ...extra }, body });

export class DavServer {
  /**
   * @param {object} o
   * @param {Function} o.authenticate async (user, pass) -> account context | null
   *   context: { key, email, displayName, calendars: [...], addressBooks: [...] }
   */
  constructor({ authenticate, log = null, realm = "EWS Bridge" }) {
    this.authenticate = authenticate;
    this.log = log;
    this.realm = realm;
  }

  async handle(req) {
    const ctx = await this.#auth(req);
    if (!ctx) {
      return { status: 401, headers: { "WWW-Authenticate": `Basic realm="${this.realm}"`, "Content-Type": "text/plain" }, body: "Authentication required" };
    }
    const path = decodeURI(req.path).replace(/\/{2,}/g, "/");
    const seg = path.split("/").filter(Boolean);
    const body = req.body ? utf8Decode(req.body) : "";
    try {
      if (req.method == "OPTIONS") {
        return {
          status: 200,
          headers: {
            DAV: "1, 2, 3, access-control, calendar-access, calendar-auto-schedule, addressbook",
            Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT",
          },
          body: "",
        };
      }
      if (seg[0] == ".well-known" || seg.length == 0) {
        if (req.method == "PROPFIND" && seg.length == 0) {
          return this.#propfindRoot(ctx, body);
        }
        return { status: 301, headers: { Location: `/principals/${ctx.key}/` }, body: "" };
      }
      if (seg[1] && seg[1] != ctx.key) {
        return { status: 403, body: "Forbidden" };
      }
      if (seg[0] == "principals") {
        if (req.method != "PROPFIND") {
          return { status: 405, body: "" };
        }
        return this.#propfindPrincipal(ctx, body);
      }
      const kind = seg[0] == "calendars" ? "calendar" : seg[0] == "addressbooks" ? "addressbook" : null;
      if (!kind) {
        return { status: 404, body: "Not found" };
      }
      const collections = kind == "calendar" ? ctx.calendars : ctx.addressBooks;
      if (seg.length == 2) {
        if (req.method != "PROPFIND") {
          return { status: 405, body: "" };
        }
        return this.#propfindHome(ctx, kind, collections, body, req.headers.depth);
      }
      const col = collections.find(c => c.id == seg[2]);
      if (!col) {
        return { status: 404, body: "No such collection" };
      }
      if (seg.length == 3) {
        if (req.method == "PROPFIND") {
          return this.#propfindCollection(ctx, kind, col, body, req.headers.depth);
        }
        if (req.method == "REPORT") {
          return this.#report(ctx, kind, col, body);
        }
        return { status: 405, body: "" };
      }
      const href = seg.slice(3).join("/");
      switch (req.method) {
        case "GET":
        case "HEAD": {
          const r = await col.get(href);
          if (!r) {
            return { status: 404, body: "Not found" };
          }
          return { status: 200, headers: { "Content-Type": KIND[kind].mime, ETag: r.etag }, body: r.ical ?? r.vcard };
        }
        case "PUT": {
          const r = await col.put(href, body, { ifMatch: req.headers["if-match"] || null, ifNoneMatch: req.headers["if-none-match"] || null });
          return { status: r.created ? 201 : 204, headers: { ETag: r.etag }, body: "" };
        }
        case "DELETE":
          await col.delete(href, { ifMatch: req.headers["if-match"] || null });
          return { status: 204, body: "" };
        case "PROPFIND": {
          const list = await col.list();
          const item = list.find(i => i.href == href);
          if (!item) {
            return { status: 404, body: "" };
          }
          const props = requestedProps(body, [[D, "getetag"], [D, "resourcetype"]]);
          return xmlResponse(207, multistatus([propResponse(this.#itemUrl(ctx, kind, col, href), props, (ns, n) => this.#itemProp(kind, item, ns, n))]));
        }
        default:
          return { status: 405, body: "" };
      }
    } catch (e) {
      if (e instanceof CalendarError || e.status) {
        return { status: e.status, headers: { "Content-Type": "text/plain" }, body: e.message };
      }
      this.log?.error(`DAV ${req.method} ${req.path}: ${e.stack || e.message}`);
      const status = e.name == "EwsAuthError" || e.name == "EwsNetworkError" ? 503 : 502;
      return { status, headers: { "Content-Type": "text/plain" }, body: `Exchange error: ${e.message}` };
    }
  }

  async #auth(req) {
    const h = req.headers.authorization || "";
    const m = /^Basic\s+(.+)$/i.exec(h);
    if (!m) {
      return null;
    }
    const decoded = utf8Decode(base64Decode(m[1]));
    const i = decoded.indexOf(":");
    if (i < 0) {
      return null;
    }
    return this.authenticate(decoded.slice(0, i), decoded.slice(i + 1));
  }

  #principalUrl(ctx) {
    return `/principals/${ctx.key}/`;
  }

  #homeUrl(ctx, kind) {
    return `/${KIND[kind].root}/${ctx.key}/`;
  }

  #colUrl(ctx, kind, col) {
    return `${this.#homeUrl(ctx, kind)}${col.id}/`;
  }

  #itemUrl(ctx, kind, col, href) {
    return `${this.#colUrl(ctx, kind, col)}${href}`;
  }

  #commonProp(ctx, ns, name) {
    if (ns == D && name == "current-user-principal") {
      return `<d:href>${this.#principalUrl(ctx)}</d:href>`;
    }
    if (ns == D && name == "principal-URL") {
      return `<d:href>${this.#principalUrl(ctx)}</d:href>`;
    }
    if (ns == D && name == "owner") {
      return `<d:href>${this.#principalUrl(ctx)}</d:href>`;
    }
    if (ns == C && name == "calendar-home-set") {
      return `<d:href>${this.#homeUrl(ctx, "calendar")}</d:href>`;
    }
    if (ns == CR && name == "addressbook-home-set") {
      return `<d:href>${this.#homeUrl(ctx, "addressbook")}</d:href>`;
    }
    if (ns == C && name == "calendar-user-address-set") {
      return `<d:href>mailto:${xmlEscape(ctx.email)}</d:href><d:href>${this.#principalUrl(ctx)}</d:href>`;
    }
    if (ns == D && name == "current-user-privilege-set") {
      return ["read", "write", "write-properties", "write-content", "bind", "unbind", "read-current-user-privilege-set"].map(p => `<d:privilege><d:${p}/></d:privilege>`).join("");
    }
    if (ns == D && name == "supported-report-set") {
      return null;
    }
    return undefined;
  }

  #propfindRoot(ctx, body) {
    const props = requestedProps(body, [[D, "current-user-principal"], [D, "resourcetype"]]);
    return xmlResponse(207, multistatus([propResponse("/", props, (ns, n) => (ns == D && n == "resourcetype" ? "<d:collection/>" : this.#commonProp(ctx, ns, n)))]));
  }

  #propfindPrincipal(ctx, body) {
    const props = requestedProps(body, [[D, "resourcetype"], [D, "displayname"], [C, "calendar-home-set"], [CR, "addressbook-home-set"], [C, "calendar-user-address-set"]]);
    const values = (ns, n) => {
      if (ns == D && n == "resourcetype") return "<d:principal/>";
      if (ns == D && n == "displayname") return xmlEscape(ctx.displayName || ctx.email);
      if (ns == C && n == "calendar-user-type") return "INDIVIDUAL";
      return this.#commonProp(ctx, ns, n);
    };
    return xmlResponse(207, multistatus([propResponse(this.#principalUrl(ctx), props, values)]));
  }

  async #propfindHome(ctx, kind, collections, body, depth = "0") {
    const props = requestedProps(body, [[D, "resourcetype"], [D, "displayname"]]);
    const responses = [propResponse(this.#homeUrl(ctx, kind), props, (ns, n) => (ns == D && n == "resourcetype" ? "<d:collection/>" : ns == D && n == "displayname" ? "Home" : this.#commonProp(ctx, ns, n)))];
    if (depth != "0") {
      for (const col of collections) {
        await col.sync();
        responses.push(propResponse(this.#colUrl(ctx, kind, col), props, (ns, n) => this.#collectionProp(ctx, kind, col, ns, n)));
      }
    }
    return xmlResponse(207, multistatus(responses));
  }

  #collectionProp(ctx, kind, col, ns, name) {
    if (ns == D && name == "resourcetype") {
      return kind == "calendar" ? "<d:collection/><c:calendar/>" : "<d:collection/><card:addressbook/>";
    }
    if (ns == D && name == "displayname") return xmlEscape(col.displayName);
    if (ns == CS && name == "getctag") return xmlEscape(col.ctag);
    if (ns == D && name == "getetag") return xmlEscape(col.ctag);
    if (ns == D && name == "supported-report-set") {
      const reports = kind == "calendar" ? ["c:calendar-multiget", "c:calendar-query"] : ["card:addressbook-multiget", "card:addressbook-query"];
      return reports.map(r => `<d:supported-report><d:report><${r}/></d:report></d:supported-report>`).join("");
    }
    if (kind == "calendar") {
      if (ns == C && name == "supported-calendar-component-set") return '<c:comp name="VEVENT"/>';
      if (ns == C && name == "supported-calendar-data") return '<c:calendar-data content-type="text/calendar" version="2.0"/>';
      if (ns == ICAL && name == "calendar-color") return col.color || "#0078D4";
      if (ns == C && name == "schedule-calendar-transp") return "<c:opaque/>";
      if (ns == C && name == "calendar-description") return xmlEscape(`Exchange: ${col.displayName}`);
    } else {
      if (ns == CR && name == "supported-address-data") return '<card:address-data-type content-type="text/vcard" version="3.0"/>';
      if (ns == CR && name == "addressbook-description") return xmlEscape(`Exchange: ${col.displayName}`);
    }
    return this.#commonProp(ctx, ns, name);
  }

  #itemProp(kind, item, ns, name) {
    if (ns == D && name == "getetag") return xmlEscape(item.etag);
    if (ns == D && name == "getcontenttype") return KIND[kind].mime;
    if (ns == D && name == "resourcetype") return "";
    return undefined;
  }

  async #propfindCollection(ctx, kind, col, body, depth = "0") {
    await col.sync({ force: true });
    const props = requestedProps(body, [[D, "resourcetype"], [D, "displayname"], [CS, "getctag"], [D, "getetag"]]);
    const responses = [propResponse(this.#colUrl(ctx, kind, col), props, (ns, n) => this.#collectionProp(ctx, kind, col, ns, n))];
    if (depth == "1") {
      for (const item of await col.list()) {
        responses.push(propResponse(this.#itemUrl(ctx, kind, col, item.href), props, (ns, n) => (ns == D && n == "resourcetype" ? "" : this.#itemProp(kind, item, ns, n))));
      }
    }
    return xmlResponse(207, multistatus(responses));
  }

  async #report(ctx, kind, col, body) {
    const doc = parseXml(body);
    const props = doc.child("prop") ? doc.child("prop").elements().map(e => [e.ns, e.name]) : [[D, "getetag"]];
    const [dataNs, dataName] = KIND[kind].dataProp;
    const wantsData = props.some(([ns, n]) => ns == dataNs && n == dataName);
    let hrefs;
    if (doc.name == "calendar-multiget" || doc.name == "addressbook-multiget") {
      const base = this.#colUrl(ctx, kind, col);
      hrefs = doc.elements("href").map(h => decodeURI(h.text.trim().replace(/^https?:\/\/[^/]+/i, "")).replace(base, "").replace(/^\/+/, ""));
    } else if (doc.name == "calendar-query" || doc.name == "addressbook-query") {
      // Component filter: we only hold VEVENTs / vCards.
      const compFilters = doc.findAll("comp-filter").map(f => f.attr("name"));
      if (kind == "calendar" && compFilters.length && !compFilters.includes("VEVENT")) {
        return xmlResponse(207, multistatus([]));
      }
      await col.sync({ force: true });
      hrefs = (await col.list()).map(i => i.href);
    } else {
      return xmlResponse(403, `<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:supported-report/></d:error>`);
    }
    const responses = [];
    const results = wantsData ? await col.multiget(hrefs) : (await col.list()).filter(i => hrefs.includes(i.href));
    for (const r of results) {
      const url = this.#itemUrl(ctx, kind, col, r.href);
      if (!r || r.error || (wantsData && !(r.ical ?? r.vcard))) {
        responses.push(`<d:response><d:href>${xmlEscape(url)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`);
        continue;
      }
      responses.push(
        propResponse(url, props, (ns, n) => {
          if (ns == dataNs && n == dataName) return xmlEscape(r.ical ?? r.vcard);
          if (ns == D && n == "getetag") return xmlEscape(r.etag);
          return this.#itemProp(kind, r, ns, n);
        })
      );
    }
    return xmlResponse(207, multistatus(responses));
  }
}

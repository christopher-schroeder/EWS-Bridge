/* EWS Bridge — an Exchange contacts folder as a CardDAV collection. */

import { fieldURI } from "../ews/items.mjs";
import { fnv1a, KeyedMutex } from "../util.mjs";
import { ewsToContact, contactToVCard, vcardToContact, contactToCreateXml, diffContacts, uidFieldURI } from "./convert.mjs";
import { CalendarError as DavError } from "../cal/calendar.mjs";

export class ExchangeAddressBook {
  constructor({ ews, store, key, id, folder, displayName, log = null, minSyncIntervalMs = 15000, now = () => Date.now() }) {
    Object.assign(this, { ews, store, key, id, folder, displayName, log, minSyncIntervalMs, now });
    this.state = null;
    this.lastSync = 0;
    this.cache = new Map();
    this.mutex = new KeyedMutex();
  }

  async #load() {
    if (!this.state) {
      this.state = (await this.store.load(this.key)) || { v: 1, syncState: null, ctag: 1, items: {}, hrefs: {} };
    }
  }

  async #save() {
    await this.store.save(this.key, this.state);
  }

  get ctag() {
    return `"${this.state?.ctag ?? 0}"`;
  }

  async sync({ force = false } = {}) {
    return this.mutex.run("sync", async () => {
      await this.#load();
      if (!force && this.now() - this.lastSync < this.minSyncIntervalMs) {
        return;
      }
      let changed = false;
      for (let page = 0; page < 1000; page++) {
        let r;
        try {
          r = await this.ews.syncFolderItems(this.folder, this.state.syncState, { props: [fieldURI("item:ItemClass")] });
        } catch (e) {
          if (e.code == "ErrorInvalidSyncStateData") {
            this.state.syncState = null;
            continue;
          }
          throw e;
        }
        for (const c of r.changes) {
          if (c.type == "create" || c.type == "update") {
            if (c.item && c.item.kind != "Contact") {
              continue; // distribution lists are not exposed
            }
            const existing = this.state.items[c.id];
            if (existing) {
              if (existing.changeKey != c.changeKey) {
                existing.changeKey = c.changeKey;
                changed = true;
              }
            } else {
              const href = `${fnv1a(c.id)}${fnv1a("~" + c.id)}.vcf`;
              this.state.items[c.id] = { href, changeKey: c.changeKey };
              this.state.hrefs[href] = c.id;
              changed = true;
            }
          } else if (c.type == "delete" && this.state.items[c.id]) {
            delete this.state.hrefs[this.state.items[c.id].href];
            delete this.state.items[c.id];
            this.cache.delete(c.id);
            changed = true;
          }
        }
        this.state.syncState = r.syncState;
        if (r.includesLast) {
          break;
        }
      }
      if (changed) {
        this.state.ctag++;
      }
      this.lastSync = this.now();
      await this.#save();
    });
  }

  async list() {
    await this.sync();
    return Object.entries(this.state.items).map(([id, it]) => ({ href: it.href, etag: `"${it.changeKey}"`, id }));
  }

  async #fetch(id) {
    const [item] = await this.ews.getItems([id], { base: "AllProperties", bodyType: "Text", props: [uidFieldURI()] });
    if (!item) {
      return null;
    }
    const m = ewsToContact(item.element);
    m.uid ||= `exchange-${fnv1a(id)}${fnv1a("~" + id)}`;
    return m;
  }

  async get(href) {
    await this.#load();
    let id = this.state.hrefs[href];
    if (!id) {
      await this.sync({ force: true });
      id = this.state.hrefs[href];
      if (!id) {
        return null;
      }
    }
    const it = this.state.items[id];
    const cached = this.cache.get(id);
    if (cached && cached.changeKey == it.changeKey) {
      return { vcard: cached.vcard, etag: `"${it.changeKey}"` };
    }
    const m = await this.#fetch(id);
    if (!m) {
      return null;
    }
    it.changeKey = m.changeKey || it.changeKey;
    const vcard = contactToVCard(m);
    this.cache.set(id, { changeKey: it.changeKey, vcard });
    return { vcard, etag: `"${it.changeKey}"` };
  }

  async multiget(hrefs) {
    const out = [];
    for (const h of hrefs) {
      try {
        out.push({ href: h, ...(await this.get(h)) });
      } catch (e) {
        out.push({ href: h, error: e });
      }
    }
    return out;
  }

  async put(href, text, { ifMatch = null, ifNoneMatch = null } = {}) {
    await this.#load();
    let model;
    try {
      model = vcardToContact(text);
    } catch (e) {
      throw new DavError(400, e.message);
    }
    const id = this.state.hrefs[href];
    if (id && ifNoneMatch == "*") {
      throw new DavError(412, "Resource already exists");
    }
    if (!id) {
      if (ifMatch) {
        throw new DavError(412, "Resource does not exist");
      }
      const [created] = await this.ews.createItems(contactToCreateXml(model), { folder: this.folder });
      this.state.items[created.id] = { href, changeKey: created.changeKey };
      this.state.hrefs[href] = created.id;
      this.state.ctag++;
      await this.#save();
      return { etag: `"${created.changeKey}"`, created: true };
    }
    const old = await this.#fetch(id);
    if (!old) {
      throw new DavError(412, "Contact was deleted on the server");
    }
    if (ifMatch && ifMatch != "*" && ifMatch.replace(/^W\//, "") != `"${old.changeKey}"`) {
      throw new DavError(412, "Contact changed on the server");
    }
    const d = diffContacts(old, model);
    let changeKey = old.changeKey;
    if (d.set.length || d.del.length) {
      const [r] = await this.ews.updateItems([{ id, set: d.set, del: d.del }]);
      changeKey = r?.changeKey || changeKey;
    }
    this.state.items[id].changeKey = changeKey;
    this.cache.delete(id);
    this.state.ctag++;
    await this.#save();
    return { etag: `"${changeKey}"`, created: false };
  }

  async delete(href, { ifMatch = null } = {}) {
    await this.#load();
    const id = this.state.hrefs[href];
    if (!id) {
      throw new DavError(404, "Not found");
    }
    await this.ews.deleteItems([id], { deleteType: "MoveToDeletedItems" });
    delete this.state.hrefs[href];
    delete this.state.items[id];
    this.cache.delete(id);
    this.state.ctag++;
    await this.#save();
  }
}

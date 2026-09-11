/* EWS Bridge — one Exchange calendar folder as a CalDAV collection. */

import { fieldURI } from "../ews/items.mjs";
import { fnv1a, KeyedMutex } from "../util.mjs";
import { parseCalendar, serialize } from "./ical.mjs";
import { ewsToModel, modelToIcal, icalToModel, modelToCreateXml, diffModels, withoutSelf, responseOf, ConversionError } from "./convert.mjs";

export class CalendarError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EVENT_PROPS = [
  fieldURI("calendar:UID"),
  fieldURI("calendar:StartTimeZone"),
  fieldURI("calendar:EndTimeZone"),
  fieldURI("calendar:ModifiedOccurrences"),
  fieldURI("calendar:DeletedOccurrences"),
  fieldURI("calendar:Recurrence"),
  fieldURI("calendar:OriginalStart"),
];

const RESPONSE_OPS = { Accept: "AcceptItem", Tentative: "TentativelyAcceptItem", Decline: "DeclineItem" };

export class ExchangeCalendar {
  /**
   * @param {object} o
   * @param {object} o.ews        EwsClient
   * @param {object} o.store
   * @param {string} o.key        persistence key
   * @param {string} o.id         collection id used in URLs
   * @param {string} o.folder     "@calendar" or folder id
   * @param {string} o.displayName
   * @param {string} o.ownEmail
   * @param {string} o.defaultTz  IANA zone for floating times
   */
  constructor({ ews, store, key, id, folder, displayName, ownEmail, defaultTz = "UTC", log = null, minSyncIntervalMs = 15000, now = () => Date.now() }) {
    Object.assign(this, { ews, store, key, id, folder, displayName, ownEmail, defaultTz, log, minSyncIntervalMs, now });
    this.state = null; // { syncState, ctag, items: { itemId: { href, changeKey, uid } }, hrefs: { href: itemId } }
    this.lastSync = 0;
    this.cache = new Map(); // itemId -> { changeKey, ical }
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

  static hrefFor(itemId) {
    return `${fnv1a(itemId)}${fnv1a("~" + itemId)}.ics`;
  }

  /** Pull changes from Exchange (throttled unless forced). */
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
          r = await this.ews.syncFolderItems(this.folder, this.state.syncState, { props: [fieldURI("calendar:UID")] });
        } catch (e) {
          if (e.code == "ErrorInvalidSyncStateData") {
            this.state.syncState = null;
            continue;
          }
          throw e;
        }
        for (const c of r.changes) {
          if (c.type == "create" || c.type == "update") {
            const existing = this.state.items[c.id];
            if (existing) {
              if (existing.changeKey != c.changeKey) {
                existing.changeKey = c.changeKey;
                changed = true;
              }
            } else {
              const href = ExchangeCalendar.hrefFor(c.id);
              this.state.items[c.id] = { href, changeKey: c.changeKey, uid: c.item?.element?.childText("UID") || null };
              this.state.hrefs[href] = c.id;
              changed = true;
            }
          } else if (c.type == "delete") {
            const existing = this.state.items[c.id];
            if (existing) {
              delete this.state.hrefs[existing.href];
              delete this.state.items[c.id];
              this.cache.delete(c.id);
              changed = true;
            }
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

  get ctag() {
    return `"${this.state?.ctag ?? 0}"`;
  }

  async list() {
    await this.sync();
    return Object.entries(this.state.items).map(([id, it]) => ({ href: it.href, etag: `"${it.changeKey}"`, id }));
  }

  #itemForHref(href) {
    const id = this.state.hrefs[href];
    return id ? { id, ...this.state.items[id] } : null;
  }

  /** Fetch a calendar item (with its exceptions) as a model. */
  async #fetchModel(itemId) {
    const [item] = await this.ews.getItems([itemId], { base: "AllProperties", bodyType: "Text", props: EVENT_PROPS });
    if (!item) {
      return null;
    }
    const model = ewsToModel(item.element, { defaultTz: this.defaultTz });
    if (model.modifiedOccurrences.length) {
      const occ = await this.ews.getItems(model.modifiedOccurrences.map(o => o.id), { base: "AllProperties", bodyType: "Text", props: EVENT_PROPS });
      model.exceptions = occ.filter(Boolean).map((o, i) => {
        const m = ewsToModel(o.element, { defaultTz: this.defaultTz });
        m.tz = model.tz;
        m.originalStart = m.originalStart ?? model.modifiedOccurrences[i].originalStart;
        return m;
      });
    }
    return model;
  }

  /** GET: iCalendar text + etag, or null. */
  async get(href) {
    await this.#load();
    let it = this.#itemForHref(href);
    if (!it) {
      await this.sync({ force: true });
      it = this.#itemForHref(href);
      if (!it) {
        return null;
      }
    }
    const cached = this.cache.get(it.id);
    if (cached && cached.changeKey == it.changeKey) {
      return { ical: cached.ical, etag: `"${it.changeKey}"` };
    }
    const model = await this.#fetchModel(it.id);
    if (!model) {
      return null;
    }
    if (model.changeKey && model.changeKey != it.changeKey) {
      this.state.items[it.id].changeKey = model.changeKey;
    }
    const ical = serialize(modelToIcal(model, { ownEmail: this.ownEmail, now: this.now() }));
    this.cache.set(it.id, { changeKey: model.changeKey, ical });
    return { ical, etag: `"${model.changeKey}"` };
  }

  async multiget(hrefs) {
    await this.#load();
    const out = [];
    for (const h of hrefs) {
      try {
        out.push({ href: h, ...(await this.get(h)) });
      } catch (e) {
        this.log?.warn(`calendar get ${h}: ${e.message}`);
        out.push({ href: h, error: e });
      }
    }
    return out;
  }

  #isOrganizer(model) {
    if (!model.isMeeting && !(model.required?.length || model.optional?.length)) {
      return true;
    }
    if (model.myResponse == "Organizer") {
      return true;
    }
    return !model.organizer?.email || model.organizer.email.toLowerCase() == this.ownEmail.toLowerCase();
  }

  /**
   * PUT. Returns { etag, created }.
   * Throws CalendarError(412) on precondition failure, (403) on unsupported content.
   */
  async put(href, icalText, { ifMatch = null, ifNoneMatch = null } = {}) {
    await this.#load();
    let newModel;
    try {
      newModel = icalToModel(parseCalendar(icalText), { defaultTz: this.defaultTz });
    } catch (e) {
      throw new CalendarError(e instanceof ConversionError ? 403 : 400, e.message);
    }
    let it = this.#itemForHref(href);
    if (it && ifNoneMatch == "*") {
      throw new CalendarError(412, "Resource already exists");
    }
    let adopted = false;
    if (!it && newModel.uid) {
      // The same event may already exist under another href (e.g. an
      // invitation Exchange put into the calendar before Thunderbird did).
      await this.sync({ force: true });
      const match = Object.entries(this.state.items).find(([, v]) => v.uid && v.uid == newModel.uid);
      if (match) {
        it = { id: match[0], ...match[1] };
        this.state.hrefs[href] = it.id;
        delete this.state.hrefs[it.href];
        this.state.items[it.id].href = href;
        it.href = href;
        adopted = true;
      }
    }
    if (!it) {
      if (ifMatch) {
        throw new CalendarError(412, "Resource does not exist");
      }
      const id = await this.#create(newModel);
      this.state.items[id.id] = { href, changeKey: id.changeKey, uid: newModel.uid };
      this.state.hrefs[href] = id.id;
      this.state.ctag++;
      await this.#save();
      return { etag: `"${id.changeKey}"`, created: true };
    }
    const oldModel = await this.#fetchModel(it.id);
    if (!oldModel) {
      throw new CalendarError(412, "Item was deleted on the server");
    }
    if (ifMatch && ifMatch.replace(/^W\//, "") != `"${oldModel.changeKey}"` && ifMatch != "*") {
      throw new CalendarError(412, "Item changed on the server");
    }
    const changeKey = await this.#update(oldModel, newModel);
    this.state.items[it.id].changeKey = changeKey || oldModel.changeKey;
    this.cache.delete(it.id);
    this.state.ctag++;
    await this.#save();
    return { etag: `"${this.state.items[it.id].changeKey}"`, created: adopted };
  }

  async #create(model) {
    const organizerIsMe = !model.organizer?.email || model.organizer.email.toLowerCase() == this.ownEmail.toLowerCase();
    let m = withoutSelf(model, [model.organizer?.email, organizerIsMe ? this.ownEmail : null]);
    if (!organizerIsMe) {
      // We cannot create a meeting on someone else's behalf; keep it as an appointment.
      m = { ...m, required: [], optional: [], resources: [] };
    }
    const hasAttendees = m.required.length || m.optional.length || m.resources.length;
    const [created] = await this.ews.createItems(modelToCreateXml(m), {
      folder: this.folder,
      sendInvitations: hasAttendees ? "SendToAllAndSaveCopy" : "SendToNone",
    });
    if (model.exceptions?.length || model.deleted?.length) {
      const master = await this.#fetchModel(created.id);
      await this.#applyExceptions(master, m, organizerIsMe);
      const [fresh] = await this.ews.getItems([created.id]);
      return { id: created.id, changeKey: fresh?.changeKey || created.changeKey };
    }
    return created;
  }

  async #update(oldModel, newModel) {
    const organizer = this.#isOrganizer(oldModel);
    let changeKey = null;
    if (!organizer) {
      // Attendee: a PARTSTAT change becomes a meeting response.
      const mine = responseOf(newModel, this.ownEmail);
      const before = oldModel.myResponse;
      if (mine && RESPONSE_OPS[mine] && mine != before) {
        await this.ews.respondToMeeting(RESPONSE_OPS[mine], { id: oldModel.id }, { send: true });
        if (mine == "Decline") {
          return null;
        }
      }
      // Personal fields only (reminder, categories, show-as).
      const personal = { ...oldModel, reminder: newModel.reminder, categories: newModel.categories, busy: newModel.busy };
      const d = diffModels(oldModel, personal);
      if (d.set.length || d.del.length) {
        const [r] = await this.ews.updateItems([{ id: oldModel.id, set: d.set, del: d.del }], { sendUpdates: "SendToNone" });
        changeKey = r?.changeKey;
      }
    } else {
      const target = withoutSelf(newModel, [oldModel.organizer?.email || this.ownEmail, this.ownEmail]);
      const d = diffModels(oldModel, target);
      if (d.set.length || d.del.length) {
        const meeting = oldModel.isMeeting || target.required.length || target.optional.length || target.resources.length;
        const [r] = await this.ews.updateItems([{ id: oldModel.id, set: d.set, del: d.del }], {
          sendUpdates: meeting && d.significant ? "SendToAllAndSaveCopy" : "SendToNone",
        });
        changeKey = r?.changeKey;
      }
      if (!d.fields.includes("calendar:Recurrence")) {
        await this.#applyExceptions(await this.#fetchModel(oldModel.id), target, true);
      }
    }
    const [fresh] = await this.ews.getItems([oldModel.id]);
    return fresh?.changeKey || changeKey;
  }

  /** Bring exceptions and deleted occurrences of `master` in line with `model`. */
  async #applyExceptions(master, model, organizer) {
    if (!master?.recurrence) {
      return;
    }
    const sameTime = (a, b) => Math.abs(a - b) < 1000;
    for (const d of model.deleted || []) {
      if (master.deleted.some(x => sameTime(x, d))) {
        continue;
      }
      const occ = await this.#findOccurrence(master, d);
      if (occ) {
        await this.ews.deleteItems([occ], { deleteType: "MoveToDeletedItems", cancellations: organizer && master.isMeeting ? "SendToAllAndSaveCopy" : "SendToNone" });
      }
    }
    for (const ex of model.exceptions || []) {
      if ((model.deleted || []).some(x => sameTime(x, ex.originalStart))) {
        continue;
      }
      const existing = master.exceptions.find(e => sameTime(e.originalStart, ex.originalStart));
      let base;
      let occId;
      if (existing) {
        base = existing;
        occId = existing.id;
      } else {
        occId = await this.#findOccurrence(master, ex.originalStart);
        if (!occId) {
          this.log?.warn(`occurrence at ${new Date(ex.originalStart).toISOString()} not found`);
          continue;
        }
        const duration = master.end - master.start;
        base = { ...master, start: ex.originalStart, end: ex.originalStart + duration, recurrence: null, exceptions: [] };
      }
      const target = withoutSelf({ ...ex, recurrence: null, tz: ex.tz || master.tz }, [master.organizer?.email || this.ownEmail, this.ownEmail]);
      const d = diffModels({ ...base, recurrence: null }, target);
      const set = d.set.filter(x => !x.includes('"calendar:Recurrence"'));
      if (set.length || d.del.length) {
        await this.ews.updateItems([{ id: occId, set, del: d.del.filter(x => !x.includes("Recurrence")) }], {
          sendUpdates: organizer && master.isMeeting && d.significant ? "SendToAllAndSaveCopy" : "SendToNone",
        });
      }
    }
  }

  async #findOccurrence(master, originalStart) {
    const ex = master.exceptions.find(e => Math.abs(e.originalStart - originalStart) < 1000);
    if (ex) {
      return ex.id;
    }
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const view = `<m:CalendarView MaxEntriesReturned="100" StartDate="${iso(originalStart - 60000)}" EndDate="${iso(originalStart + 60000)}"/>`;
    const items = await this.ews.findItems(this.folder, {
      calendarView: view,
      props: [fieldURI("calendar:UID"), fieldURI("calendar:Start"), fieldURI("calendar:CalendarItemType")],
    });
    const hit = items.find(i => i.element.childText("UID") == master.uid && Math.abs(Date.parse(i.element.childText("Start")) - originalStart) < 1000);
    return hit?.id || null;
  }

  async delete(href, { ifMatch = null } = {}) {
    await this.#load();
    const it = this.#itemForHref(href);
    if (!it) {
      throw new CalendarError(404, "Not found");
    }
    const model = await this.#fetchModel(it.id);
    if (model) {
      if (ifMatch && ifMatch != "*" && ifMatch.replace(/^W\//, "") != `"${model.changeKey}"`) {
        throw new CalendarError(412, "Item changed on the server");
      }
      if (this.#isOrganizer(model)) {
        const meeting = model.isMeeting && (model.required.length || model.optional.length || model.resources.length);
        await this.ews.deleteItems([it.id], { deleteType: "MoveToDeletedItems", cancellations: meeting ? "SendToAllAndSaveCopy" : "SendToNone" });
      } else if (!model.cancelled) {
        // RFC 6638: an attendee deleting the event declines it.
        await this.ews.respondToMeeting("DeclineItem", { id: it.id }, { send: true });
      } else {
        await this.ews.deleteItems([it.id], { deleteType: "MoveToDeletedItems" });
      }
    }
    delete this.state.hrefs[href];
    delete this.state.items[it.id];
    this.cache.delete(it.id);
    this.state.ctag++;
    await this.#save();
  }
}

/* EWS Bridge — mail account model behind the IMAP gateway.
 *
 * Maps each Exchange mail folder to an IMAP mailbox with stable UIDs.
 * The mapping (EWS ItemId <-> UID) and the EWS sync state are persisted so
 * Thunderbird never sees a UIDVALIDITY change unless the folder itself is
 * replaced.
 */

import { EwsClient, MAIL_SYNC_PROPS, MAIL_HEADER_PROPS } from "../ews/client.mjs";
import { PROP, VERB_REPLY, VERB_REPLY_ALL, VERB_FORWARD } from "../ews/items.mjs";
import { DebouncedWriter } from "../store.mjs";
import { KeyedMutex, fnv1a } from "../util.mjs";
import { xmlEscape } from "../xml.mjs";

export const F_SEEN = 1;
export const F_FLAGGED = 2;
export const F_ANSWERED = 4;
export const F_DELETED = 8;
export const F_DRAFT = 16;

export const FLAG_NAMES = [
  [F_SEEN, "\\Seen"],
  [F_FLAGGED, "\\Flagged"],
  [F_ANSWERED, "\\Answered"],
  [F_DELETED, "\\Deleted"],
  [F_DRAFT, "\\Draft"],
];

export const KW_FORWARDED = "$Forwarded";

/** Keywords Thunderbird uses that have no Exchange equivalent; kept locally. */
const LOCAL_KEYWORDS = new Set(["$mdnsent", "junk", "nonjunk", "$junk", "$notjunk", "$submitpending"]);

export const DELIMITER = "/";
const SLASH_SUBSTITUTE = "∕"; // U+2215 DIVISION SLASH, stands in for "/" inside names

const SPECIAL_USE = {
  sentitems: "\\Sent",
  drafts: "\\Drafts",
  deleteditems: "\\Trash",
  junkemail: "\\Junk",
  archive: "\\Archive",
};

export class MailboxError extends Error {
  constructor(message, code = "NO") {
    super(message);
    this.imapCode = code; // e.g. NONEXISTENT, ALREADYEXISTS, CANNOT
  }
}

export class FolderState {
  constructor(name, ewsFolder) {
    this.name = name; // IMAP name (Unicode)
    this.ewsId = ewsFolder.id;
    this.parentEwsId = ewsFolder.parentId;
    this.displayName = ewsFolder.displayName;
    this.distinguishedId = ewsFolder.distinguishedId || null;
    this.specialUse = SPECIAL_USE[this.distinguishedId] || null;
    this.uidValidity = 0;
    this.uidNext = 1;
    this.syncState = null;
    this.msgs = []; // sorted by uid
    this.byUid = new Map();
    this.byId = new Map();
    this.loaded = false;
    this.lastSync = 0;
    this.syncComplete = false;
    this.listeners = new Set();
    this.hasChildren = false;
  }

  get exists() {
    return this.msgs.length;
  }

  get unseen() {
    let n = 0;
    for (const m of this.msgs) {
      if (!(m.flags & F_SEEN)) {
        n++;
      }
    }
    return n;
  }

  add(msg) {
    this.msgs.push(msg);
    this.byUid.set(msg.uid, msg);
    this.byId.set(msg.id, msg);
    if (msg.uid >= this.uidNext) {
      this.uidNext = msg.uid + 1;
    }
  }

  remove(msg) {
    this.byUid.delete(msg.uid);
    this.byId.delete(msg.id);
    const i = binarySearch(this.msgs, msg.uid);
    if (i >= 0) {
      this.msgs.splice(i, 1);
    }
  }

  rekey(msg, newId, newChangeKey = null) {
    this.byId.delete(msg.id);
    msg.id = newId;
    msg.changeKey = newChangeKey;
    this.byId.set(newId, msg);
  }

  toJSON() {
    return {
      v: 1,
      ewsId: this.ewsId,
      uidValidity: this.uidValidity,
      uidNext: this.uidNext,
      syncState: this.syncState,
      syncComplete: this.syncComplete,
      msgs: this.msgs.map(m => [m.uid, m.id, m.changeKey, m.flags, m.size, m.received, m.keywords.length ? m.keywords : 0, m.kind == "Message" ? 0 : m.kind, m.localKeywords.length ? m.localKeywords : 0]),
    };
  }

  loadJSON(doc) {
    this.uidValidity = doc.uidValidity;
    this.uidNext = doc.uidNext;
    this.syncState = doc.syncState;
    this.syncComplete = !!doc.syncComplete;
    for (const [uid, id, changeKey, flags, size, received, keywords, kind, localKeywords] of doc.msgs) {
      this.add({ uid, id, changeKey, flags, size, received, keywords: keywords || [], kind: kind || "Message", localKeywords: localKeywords || [] });
    }
    this.msgs.sort((a, b) => a.uid - b.uid);
  }
}

function binarySearch(msgs, uid) {
  let lo = 0;
  let hi = msgs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const u = msgs[mid].uid;
    if (u == uid) {
      return mid;
    }
    if (u < uid) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

/** Keyword as used by Thunderbird for a category name (see nsMsgTagService). */
export function defaultCategoryToKeyword(name) {
  return name.toLowerCase().replace(/[\s()\[\]{}%*"\\]/g, "_");
}

export class MailAccount {
  /**
   * @param {object} o
   * @param {EwsClient} o.ews
   * @param {object} o.store      persistence (load/save)
   * @param {string} o.key        account key for persistence
   * @param {object} [o.log]
   * @param {object} [o.timers]   { setTimeout, clearTimeout, now }
   * @param {object} [o.tags]     { categoryToKeyword(name), keywordToCategory(kw) }
   */
  constructor({ ews, store, key, log = null, timers = globalThis, tags = null, minSyncIntervalMs = 5000, syncBudgetMs = 20000 }) {
    this.ews = ews;
    this.store = store;
    this.key = key;
    this.log = log;
    this.timers = timers;
    this.now = timers.now ? () => timers.now() : () => Date.now();
    this.tags = tags || {
      categoryToKeyword: defaultCategoryToKeyword,
      keywordToCategory: kw => null,
    };
    this.categoryByKeyword = new Map();
    this.minSyncIntervalMs = minSyncIntervalMs;
    this.syncBudgetMs = syncBudgetMs;
    this.writer = new DebouncedWriter(store, 1500, timers);
    this.mutex = new KeyedMutex();
    this.foldersByName = new Map(); // lower-case-insensitive for INBOX only
    this.foldersByEwsId = new Map();
    this.distinguished = null;
    this.folderIndex = null; // { ewsId: { uidValidity } }
    this.lastFolderRefresh = 0;
    this.mimeCache = new Map(); // id -> binary (LRU by insertion order)
    this.mimeCacheBytes = 0;
    this.headerCache = new Map(); // id -> item (EWS header properties)
  }

  #indexKey() {
    return `${this.key}/folders`;
  }

  #folderKey(f) {
    return `${this.key}/f-${fnv1a(f.ewsId)}`;
  }

  // ------------------------------------------------------------------ folders

  async refreshFolders({ force = false } = {}) {
    return this.mutex.run("#folders", async () => {
      if (!force && this.foldersByName.size && this.now() - this.lastFolderRefresh < 30000) {
        return;
      }
      if (!this.folderIndex) {
        this.folderIndex = (await this.store.load(this.#indexKey())) || { v: 1, folders: {}, unsubscribed: [] };
      }
      if (!this.distinguished) {
        this.distinguished = await this.ews.getDistinguishedFolders();
      }
      const root = this.distinguished.msgfolderroot;
      if (!root) {
        throw new MailboxError("Mailbox root folder not accessible");
      }
      const all = await this.ews.findFoldersDeep("@msgfolderroot");
      const byId = new Map(all.map(f => [f.id, f]));
      const distinguishedById = new Map(Object.entries(this.distinguished).map(([k, f]) => [f.id, k]));
      const isMail = f =>
        f.kind == "Folder" && (!f.folderClass || (f.folderClass.startsWith("IPF.Note") && !f.folderClass.startsWith("IPF.Note.OutlookHomepage"))) &&
        distinguishedById.get(f.id) != "outbox";

      const nameOf = f => {
        const parts = [];
        let cur = f;
        for (let depth = 0; cur && cur.id != root.id && depth < 64; depth++) {
          if (!isMail(cur)) {
            return null;
          }
          if (distinguishedById.get(cur.id) == "inbox") {
            parts.unshift("INBOX");
            break;
          }
          parts.unshift(cur.displayName.replaceAll(DELIMITER, SLASH_SUBSTITUTE));
          cur = byId.get(cur.parentId);
          if (!cur && parts.length) {
            // parent outside msgfolderroot — treat as top level
            break;
          }
        }
        return parts.join(DELIMITER);
      };

      const newByName = new Map();
      const newByEwsId = new Map();
      for (const f of all) {
        f.distinguishedId = distinguishedById.get(f.id) || null;
        const name = nameOf(f);
        if (!name) {
          continue;
        }
        let state = this.foldersByEwsId.get(f.id);
        if (state) {
          state.name = name;
          state.displayName = f.displayName;
          state.parentEwsId = f.parentId;
        } else {
          state = new FolderState(name, f);
          const known = this.folderIndex.folders[f.id];
          state.uidValidity = known?.uidValidity || this.#newUidValidity();
          if (!known) {
            this.folderIndex.folders[f.id] = { uidValidity: state.uidValidity };
          }
        }
        state.hasChildren = false;
        newByName.set(name.toUpperCase() == "INBOX" ? "INBOX" : name, state);
        newByEwsId.set(f.id, state);
      }
      for (const s of newByEwsId.values()) {
        const parent = newByEwsId.get(s.parentEwsId);
        if (parent) {
          parent.hasChildren = true;
        }
      }
      this.foldersByName = newByName;
      this.foldersByEwsId = newByEwsId;
      this.lastFolderRefresh = this.now();
      await this.store.save(this.#indexKey(), this.folderIndex);
    });
  }

  #newUidValidity() {
    // Seconds since epoch, strictly increasing within this process.
    const v = Math.max(Math.floor(this.now() / 1000), (this.lastUidValidity || 0) + 1);
    this.lastUidValidity = v;
    return v;
  }

  folders() {
    return [...this.foldersByName.values()];
  }

  getFolder(name) {
    if (name.toUpperCase() == "INBOX") {
      return this.foldersByName.get("INBOX") || null;
    }
    if (name.toUpperCase().startsWith("INBOX" + DELIMITER)) {
      name = "INBOX" + name.slice(5);
    }
    return this.foldersByName.get(name) || null;
  }

  specialFolder(distinguishedId) {
    const f = this.distinguished?.[distinguishedId];
    return f ? this.foldersByEwsId.get(f.id) || null : null;
  }

  isSubscribed(folder) {
    return !this.folderIndex?.unsubscribed?.includes(folder.ewsId);
  }

  async setSubscribed(folder, subscribed) {
    const list = new Set(this.folderIndex.unsubscribed || []);
    if (subscribed) {
      list.delete(folder.ewsId);
    } else {
      list.add(folder.ewsId);
    }
    this.folderIndex.unsubscribed = [...list];
    await this.store.save(this.#indexKey(), this.folderIndex);
  }

  #splitName(name) {
    const parts = name.split(DELIMITER).filter(Boolean);
    const leaf = parts.pop();
    return { parentName: parts.join(DELIMITER), leaf: leaf.replaceAll(SLASH_SUBSTITUTE, "/") };
  }

  #parentRef(parentName) {
    if (!parentName) {
      return this.distinguished.msgfolderroot.id;
    }
    const parent = this.getFolder(parentName);
    if (!parent) {
      throw new MailboxError(`Parent folder ${parentName} does not exist`, "NONEXISTENT");
    }
    return parent.ewsId;
  }

  async createFolder(name) {
    await this.refreshFolders();
    name = name.replace(/\/+$/, "");
    if (this.getFolder(name)) {
      throw new MailboxError("Folder already exists", "ALREADYEXISTS");
    }
    const { parentName, leaf } = this.#splitName(name);
    try {
      await this.ews.createFolder(this.#parentRef(parentName), leaf, "IPF.Note");
    } catch (e) {
      if (e.code == "ErrorFolderExists") {
        throw new MailboxError("Folder already exists", "ALREADYEXISTS");
      }
      throw e;
    }
    await this.refreshFolders({ force: true });
  }

  async deleteFolder(name) {
    await this.refreshFolders();
    const f = this.getFolder(name);
    if (!f) {
      throw new MailboxError("No such folder", "NONEXISTENT");
    }
    if (f.distinguishedId) {
      throw new MailboxError("Special folders cannot be deleted", "CANNOT");
    }
    await this.ews.deleteFolder(f.ewsId, "SoftDelete");
    delete this.folderIndex.folders[f.ewsId];
    await this.store.remove(this.#folderKey(f));
    await this.refreshFolders({ force: true });
  }

  async renameFolder(oldName, newName) {
    await this.refreshFolders();
    const f = this.getFolder(oldName);
    if (!f) {
      throw new MailboxError("No such folder", "NONEXISTENT");
    }
    if (f.distinguishedId) {
      throw new MailboxError("Special folders cannot be renamed", "CANNOT");
    }
    newName = newName.replace(/\/+$/, "");
    if (this.getFolder(newName)) {
      throw new MailboxError("Target folder already exists", "ALREADYEXISTS");
    }
    const { parentName, leaf } = this.#splitName(newName);
    const newParent = this.#parentRef(parentName);
    if (newParent != f.parentEwsId) {
      await this.ews.moveFolder(f.ewsId, newParent);
    }
    if (leaf != f.displayName) {
      await this.ews.renameFolder(f.ewsId, leaf);
    }
    await this.refreshFolders({ force: true });
  }

  // ------------------------------------------------------------------ sync

  async #ensureLoaded(folder) {
    if (folder.loaded) {
      return;
    }
    const doc = await this.store.load(this.#folderKey(folder));
    if (doc && doc.ewsId == folder.ewsId && doc.uidValidity == folder.uidValidity) {
      folder.loadJSON(doc);
    }
    folder.loaded = true;
  }

  #persist(folder) {
    this.writer.schedule(this.#folderKey(folder), () => folder.toJSON());
  }

  flagsFromItem(item, prev = null) {
    let flags = prev ? prev.flags & F_DELETED : 0;
    if (item.isRead) {
      flags |= F_SEEN;
    }
    const flagStatus = item.ext["0x1090"];
    if (flagStatus == "2" || item.flagStatus == "Flagged") {
      flags |= F_FLAGGED;
    }
    const verb = parseInt(item.ext["0x1081"], 10);
    if (verb == VERB_REPLY || verb == VERB_REPLY_ALL) {
      flags |= F_ANSWERED;
    }
    if (item.isDraft) {
      flags |= F_DRAFT;
    }
    const keywords = [];
    if (verb == VERB_FORWARD) {
      keywords.push(KW_FORWARDED);
    }
    for (const c of item.categories || []) {
      const kw = this.tags.categoryToKeyword(c);
      if (kw) {
        this.categoryByKeyword.set(kw.toLowerCase(), c);
        keywords.push(kw);
      }
    }
    return { flags, keywords };
  }

  /**
   * Pull changes from Exchange. Returns { added: [msg], removed: [msg], changed: [msg] }
   * and notifies folder listeners.
   */
  async syncFolder(folder, { force = false } = {}) {
    return this.mutex.run(folder.ewsId, () => this.#syncLocked(folder, force));
  }

  async #syncLocked(folder, force) {
    await this.#ensureLoaded(folder);
    const result = { added: [], removed: [], changed: [] };
    if (!force && folder.syncComplete && this.now() - folder.lastSync < this.minSyncIntervalMs) {
      return result;
    }
    const started = this.now();
    const initial = !folder.syncComplete;
    const pendingNew = [];
    let complete = false;
    for (let page = 0; page < 10000; page++) {
      let r;
      try {
        r = await this.ews.syncFolderItems(folder.ewsId, folder.syncState, { props: MAIL_SYNC_PROPS });
      } catch (e) {
        if (e.code == "ErrorInvalidSyncStateData" || e.code == "ErrorInvalidSyncState") {
          this.log?.warn(`Sync state for ${folder.name} rejected; resynchronising`);
          await this.#fullResync(folder, result);
          complete = true;
          break;
        }
        if (e.code == "ErrorFolderNotFound" || e.code == "ErrorItemNotFound") {
          throw new MailboxError(`Folder ${folder.name} no longer exists on the server`, "NONEXISTENT");
        }
        throw e;
      }
      this.#applyChanges(folder, r.changes, pendingNew, result);
      folder.syncState = r.syncState;
      if (r.includesLast) {
        complete = true;
        break;
      }
      if (this.now() - started > this.syncBudgetMs) {
        break;
      }
    }
    if (initial) {
      pendingNew.sort((a, b) => a.received - b.received);
    }
    for (const m of pendingNew) {
      m.uid = folder.uidNext++;
      folder.add(m);
      result.added.push(m);
    }
    folder.syncComplete = folder.syncComplete || complete;
    folder.lastSync = this.now();
    this.#persist(folder);
    this.#notify(folder, result);
    if (!complete) {
      // Keep going in the background; clients learn about the rest via EXISTS.
      this.timers.setTimeout(() => this.syncFolder(folder, { force: true }).catch(e => this.log?.error(`background sync of ${folder.name}: ${e.message}`)), 0);
    }
    return result;
  }

  #applyChanges(folder, changes, pendingNew, result) {
    const pendingById = new Map(pendingNew.map(m => [m.id, m]));
    for (const c of changes) {
      if (c.type == "create" || c.type == "update") {
        const item = c.item;
        if (item.kind != "Message" && !item.itemClass?.startsWith("IPM")) {
          // Unknown item types in mail folders are still offered as messages.
        }
        const existing = folder.byId.get(c.id) || pendingById.get(c.id);
        const { flags, keywords } = this.flagsFromItem(item, existing);
        if (existing) {
          const changed = existing.flags != flags || existing.keywords.join(" ") != keywords.join(" ");
          existing.flags = flags;
          existing.keywords = keywords;
          existing.changeKey = c.changeKey;
          if (item.size !== null) {
            existing.size = item.size;
          }
          if (changed && existing.uid) {
            result.changed.push(existing);
          }
          if (c.type == "update") {
            this.headerCache.delete(c.id);
          }
        } else {
          const m = {
            uid: 0,
            id: c.id,
            changeKey: c.changeKey,
            kind: item.kind,
            flags,
            keywords,
            localKeywords: [],
            size: item.size || 0,
            received: Date.parse(item.dateTimeReceived || "") || this.now(),
          };
          pendingNew.push(m);
          pendingById.set(m.id, m);
        }
      } else if (c.type == "delete") {
        const existing = folder.byId.get(c.id);
        if (existing) {
          folder.remove(existing);
          result.removed.push(existing);
        } else if (pendingById.has(c.id)) {
          pendingNew.splice(pendingNew.indexOf(pendingById.get(c.id)), 1);
          pendingById.delete(c.id);
        }
        this.#dropCaches(c.id);
      } else if (c.type == "readflag") {
        const existing = folder.byId.get(c.id) || pendingById.get(c.id);
        if (existing) {
          const flags = c.isRead ? existing.flags | F_SEEN : existing.flags & ~F_SEEN;
          if (flags != existing.flags) {
            existing.flags = flags;
            if (existing.uid) {
              result.changed.push(existing);
            }
          }
        }
      }
    }
  }

  async #fullResync(folder, result) {
    const seen = new Set();
    const pendingNew = [];
    let state = null;
    for (;;) {
      const r = await this.ews.syncFolderItems(folder.ewsId, state, { props: MAIL_SYNC_PROPS });
      for (const c of r.changes) {
        if (c.type == "create") {
          seen.add(c.id);
        }
      }
      this.#applyChanges(folder, r.changes, pendingNew, result);
      state = r.syncState;
      if (r.includesLast) {
        break;
      }
    }
    for (const m of [...folder.msgs]) {
      if (!seen.has(m.id)) {
        folder.remove(m);
        result.removed.push(m);
      }
    }
    pendingNew.sort((a, b) => a.received - b.received);
    for (const m of pendingNew) {
      m.uid = folder.uidNext++;
      folder.add(m);
      result.added.push(m);
    }
    folder.syncState = state;
  }

  #notify(folder, result) {
    if (!result.added.length && !result.removed.length && !result.changed.length) {
      return;
    }
    for (const l of folder.listeners) {
      try {
        l(result);
      } catch (e) {
        this.log?.error(`listener: ${e.message}`);
      }
    }
  }

  #dropCaches(id) {
    this.headerCache.delete(id);
    const bin = this.mimeCache.get(id);
    if (bin !== undefined) {
      this.mimeCacheBytes -= bin.length;
      this.mimeCache.delete(id);
    }
  }

  async openFolder(folder) {
    await this.#ensureLoaded(folder);
    return folder;
  }

  // ------------------------------------------------------------------ content

  /** Full MIME for a message (cached). Returns null if deleted on the server. */
  async getMime(msg) {
    const cached = this.mimeCache.get(msg.id);
    if (cached !== undefined) {
      this.mimeCache.delete(msg.id);
      this.mimeCache.set(msg.id, cached);
      return cached;
    }
    const bin = await this.ews.getMime(msg.id);
    if (bin === null) {
      return null;
    }
    this.mimeCache.set(msg.id, bin);
    this.mimeCacheBytes += bin.length;
    while (this.mimeCacheBytes > 64 * 1024 * 1024 && this.mimeCache.size > 1) {
      const [oldId, oldBin] = this.mimeCache.entries().next().value;
      this.mimeCache.delete(oldId);
      this.mimeCacheBytes -= oldBin.length;
    }
    msg.exactSize = bin.length;
    return bin;
  }

  peekMime(msg) {
    return this.mimeCache.get(msg.id);
  }

  /** EWS header properties for many messages (batched, cached). */
  async getHeaderItems(msgs) {
    const need = msgs.filter(m => !this.headerCache.has(m.id));
    if (need.length) {
      const items = await this.ews.getItems(need.map(m => m.id), { props: MAIL_HEADER_PROPS, batch: 100 });
      need.forEach((m, i) => {
        if (items[i]) {
          delete items[i].element; // keep memory small
          this.headerCache.set(m.id, items[i]);
        }
      });
      while (this.headerCache.size > 5000) {
        this.headerCache.delete(this.headerCache.keys().next().value);
      }
    }
    return new Map(msgs.map(m => [m.id, this.headerCache.get(m.id) || null]));
  }

  // ------------------------------------------------------------------ changes

  /**
   * Change flags. mode: "+" add, "-" remove, "=" replace.
   * Returns the messages whose flags changed.
   */
  async storeFlags(folder, msgs, mode, flags, keywords = []) {
    return this.mutex.run(folder.ewsId, async () => {
      const changes = [];
      const touched = [];
      for (const m of msgs) {
        if (!folder.byUid.has(m.uid)) {
          continue;
        }
        let newFlags = m.flags;
        let newKeywords = new Set([...m.keywords, ...m.localKeywords]);
        const kwLower = keywords.map(k => k.toLowerCase());
        if (mode == "+") {
          newFlags |= flags;
          keywords.forEach(k => newKeywords.add(k));
        } else if (mode == "-") {
          newFlags &= ~flags;
          newKeywords = new Set([...newKeywords].filter(k => !kwLower.includes(k.toLowerCase())));
        } else {
          newFlags = (m.flags & F_DRAFT) | (flags & ~F_DRAFT);
          newKeywords = new Set(keywords);
        }
        newFlags = (newFlags & ~F_DRAFT) | (m.flags & F_DRAFT); // \Draft is not settable
        const oldKw = new Set([...m.keywords, ...m.localKeywords]);
        const kwChanged = oldKw.size != newKeywords.size || [...oldKw].some(k => !newKeywords.has(k));
        if (newFlags == m.flags && !kwChanged) {
          continue;
        }
        const set = [];
        const del = [];
        const kind = m.kind || "Message";
        const diff = newFlags ^ m.flags;
        if (diff & F_SEEN) {
          set.push(EwsClient.setField("message:IsRead", kind, `<t:IsRead>${!!(newFlags & F_SEEN)}</t:IsRead>`));
        }
        if (diff & F_FLAGGED) {
          if (newFlags & F_FLAGGED) {
            set.push(EwsClient.setExtended(PROP.FLAG_STATUS, kind, 2));
          } else {
            del.push(`<t:ExtendedFieldURI PropertyTag="${PROP.FLAG_STATUS.tag}" PropertyType="${PROP.FLAG_STATUS.type}"/>`);
          }
        }
        const wasFwd = oldKw.has(KW_FORWARDED);
        const isFwd = newKeywords.has(KW_FORWARDED);
        if (diff & F_ANSWERED || wasFwd != isFwd) {
          if (newFlags & F_ANSWERED) {
            set.push(EwsClient.setExtended(PROP.LAST_VERB_EXECUTED, kind, VERB_REPLY));
            set.push(EwsClient.setExtended(PROP.ICON_INDEX, kind, 261));
          } else if (isFwd) {
            set.push(EwsClient.setExtended(PROP.LAST_VERB_EXECUTED, kind, VERB_FORWARD));
            set.push(EwsClient.setExtended(PROP.ICON_INDEX, kind, 262));
          } else {
            del.push(`<t:ExtendedFieldURI PropertyTag="${PROP.LAST_VERB_EXECUTED.tag}" PropertyType="Integer"/>`);
            del.push(`<t:ExtendedFieldURI PropertyTag="${PROP.ICON_INDEX.tag}" PropertyType="Integer"/>`);
          }
        }
        // Keywords: categories vs. local-only
        const categories = [];
        const localKeywords = [];
        const serverKeywords = [];
        for (const k of newKeywords) {
          if (k == KW_FORWARDED) {
            serverKeywords.push(k);
            continue;
          }
          const cat = LOCAL_KEYWORDS.has(k.toLowerCase()) ? null : this.categoryByKeyword.get(k.toLowerCase()) || this.tags.keywordToCategory(k);
          if (cat) {
            categories.push(cat);
            serverKeywords.push(k);
          } else {
            localKeywords.push(k);
          }
        }
        const oldCats = m.keywords.filter(k => k != KW_FORWARDED).map(k => k.toLowerCase()).sort().join(" ");
        const newCats = serverKeywords.filter(k => k != KW_FORWARDED).map(k => k.toLowerCase()).sort().join(" ");
        if (oldCats != newCats) {
          if (categories.length) {
            set.push(EwsClient.setField("item:Categories", kind, `<t:Categories>${categories.map(c => `<t:String>${xmlEscape(c)}</t:String>`).join("")}</t:Categories>`));
          } else {
            del.push(`<t:FieldURI FieldURI="item:Categories"/>`);
          }
        }
        if (set.length || del.length) {
          changes.push({ msg: m, id: m.id, set, del, newFlags, serverKeywords, localKeywords });
        } else {
          // Only local state changed (\Deleted or local keywords)
          m.flags = newFlags;
          m.keywords = serverKeywords;
          m.localKeywords = localKeywords;
          touched.push(m);
        }
      }
      if (changes.length) {
        const results = await this.ews.updateItems(changes, { partial: true });
        results.forEach((r, i) => {
          const c = changes[i];
          if (r === null) {
            this.log?.warn(`flag update failed for uid ${c.msg.uid}`);
            return;
          }
          c.msg.flags = c.newFlags;
          c.msg.keywords = c.serverKeywords;
          c.msg.localKeywords = c.localKeywords;
          if (r.changeKey) {
            c.msg.changeKey = r.changeKey;
          }
          this.headerCache.delete(c.msg.id);
          touched.push(c.msg);
        });
      }
      if (touched.length) {
        this.#persist(folder);
        this.#notify(folder, { added: [], removed: [], changed: touched });
      }
      return touched;
    });
  }

  /** Copy (or move) messages to another folder. Returns [[srcUid, dstUid], ...]. */
  async transfer(src, msgs, dest, { move = false } = {}) {
    await this.#ensureLoaded(dest);
    const ids = msgs.map(m => m.id);
    const results = await this.mutex.run(src.ewsId, () => (move ? this.ews.moveItems(ids, dest.ewsId) : this.ews.copyItems(ids, dest.ewsId)));
    const pairs = [];
    const removed = [];
    await this.mutex.run(dest.ewsId, async () => {
      const added = [];
      results.forEach((r, i) => {
        const m = msgs[i];
        if (!r) {
          return; // source vanished
        }
        if (move && src.byUid.get(m.uid) === m) {
          src.remove(m);
          removed.push(m);
          this.#dropCaches(m.id);
        }
        if (!r.id) {
          return; // server did not return new ids (cross-mailbox) — sync will find it
        }
        let existing = dest.byId.get(r.id);
        if (!existing) {
          existing = {
            uid: dest.uidNext++,
            id: r.id,
            changeKey: r.changeKey,
            kind: m.kind,
            flags: m.flags & ~F_DELETED,
            keywords: [...m.keywords],
            localKeywords: [...m.localKeywords],
            size: m.size,
            received: m.received,
          };
          dest.add(existing);
          added.push(existing);
        }
        pairs.push([m.uid, existing.uid]);
      });
      this.#persist(dest);
      this.#notify(dest, { added, removed: [], changed: [] });
    });
    if (removed.length) {
      this.#persist(src);
      this.#notify(src, { added: [], removed, changed: [] });
    }
    return pairs;
  }

  /** Permanently remove messages (Exchange soft delete → recoverable items). */
  async expunge(folder, msgs) {
    return this.mutex.run(folder.ewsId, async () => {
      const live = msgs.filter(m => folder.byUid.get(m.uid) === m);
      if (!live.length) {
        return [];
      }
      await this.ews.deleteItems(live.map(m => m.id), { deleteType: "SoftDelete" });
      for (const m of live) {
        folder.remove(m);
        this.#dropCaches(m.id);
      }
      this.#persist(folder);
      this.#notify(folder, { added: [], removed: live, changed: [] });
      return live;
    });
  }

  /** Store a message (APPEND). Returns the new UID. */
  async append(folder, mimeBin, flags = 0, keywords = [], date = null) {
    await this.#ensureLoaded(folder);
    let msgFlags = flags & F_SEEN ? 1 : 0;
    if (flags & F_DRAFT) {
      msgFlags |= 8;
    }
    let extra = "";
    if (date && !isNaN(date)) {
      // PR_MESSAGE_DELIVERY_TIME: keeps the original received date for imported mail.
      extra += `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E06" PropertyType="SystemTime"/><t:Value>${new Date(date).toISOString().replace(/\.\d+Z$/, "Z")}</t:Value></t:ExtendedProperty>`;
    }
    if (flags & F_FLAGGED) {
      extra += `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="${PROP.FLAG_STATUS.tag}" PropertyType="Integer"/><t:Value>2</t:Value></t:ExtendedProperty>`;
    }
    const created = await this.ews.createItemFromMime(mimeBin, { folder: folder.ewsId, disposition: "SaveOnly", messageFlags: msgFlags, extra });
    return this.mutex.run(folder.ewsId, () => {
      let m = folder.byId.get(created.id);
      if (!m) {
        m = {
          uid: folder.uidNext++,
          id: created.id,
          changeKey: created.changeKey,
          kind: "Message",
          flags: flags & (F_SEEN | F_FLAGGED | F_DRAFT | F_ANSWERED),
          keywords: keywords.filter(k => k == KW_FORWARDED),
          localKeywords: keywords.filter(k => k != KW_FORWARDED),
          size: mimeBin.length,
          exactSize: mimeBin.length,
          received: date && !isNaN(date) ? new Date(date).getTime() : this.now(),
        };
        folder.add(m);
        this.mimeCache.set(m.id, mimeBin);
        this.mimeCacheBytes += mimeBin.length;
        this.#persist(folder);
        this.#notify(folder, { added: [m], removed: [], changed: [] });
      }
      return m.uid;
    });
  }

  /** Text search via EWS; returns the set of matching ItemIds in the folder. */
  async searchText(folder, criteria) {
    const restriction = criteria.length == 1 ? criteria[0] : `<t:And>${criteria.join("")}</t:And>`;
    const items = await this.ews.findItems(folder.ewsId, { restriction, max: 5000 });
    return new Set(items.map(i => i.id));
  }

  async flush() {
    await this.writer.flush();
  }
}

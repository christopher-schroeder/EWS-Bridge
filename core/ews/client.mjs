/* EWS Bridge — EWS client.
 *
 * The transport performs the HTTP exchange including authentication:
 *   transport.request({ method, url, headers, body }) ->
 *     { status, headers: {lowercase: value}, body: string }
 * and throws EwsNetworkError / EwsAuthError itself.
 */

import { xmlEscape, tag, textTag } from "../xml.mjs";
import { base64Decode, base64Encode, sleep } from "../util.mjs";
import {
  EwsError,
  EwsAuthError,
  EwsHttpError,
  envelope,
  parseEnvelope,
  responseMessages,
  checkMessage,
  messageError,
} from "./soap.mjs";
import {
  PROP,
  extFieldURI,
  extProperty,
  folderIdXml,
  itemIdXml,
  fieldURI,
  parseItem,
  parseFolder,
  parseMailbox,
} from "./items.mjs";

export const DISTINGUISHED_FOLDERS = [
  "msgfolderroot",
  "inbox",
  "drafts",
  "sentitems",
  "deleteditems",
  "junkemail",
  "outbox",
  "calendar",
  "contacts",
  "tasks",
  "notes",
  "journal",
];

/** Properties fetched for every mail item while syncing a folder. */
export const MAIL_SYNC_PROPS = [
  fieldURI("item:ItemClass"),
  fieldURI("item:Size"),
  fieldURI("item:DateTimeReceived"),
  fieldURI("message:IsRead"),
  fieldURI("item:Categories"),
  fieldURI("item:IsDraft"),
  extFieldURI(PROP.FLAG_STATUS),
  extFieldURI(PROP.LAST_VERB_EXECUTED),
];

/** Properties used to synthesise an RFC 822 header without downloading MIME. */
export const MAIL_HEADER_PROPS = [
  fieldURI("item:Subject"),
  fieldURI("message:From"),
  fieldURI("message:Sender"),
  fieldURI("message:ToRecipients"),
  fieldURI("message:CcRecipients"),
  fieldURI("message:BccRecipients"),
  fieldURI("message:ReplyTo"),
  fieldURI("item:DateTimeSent"),
  fieldURI("item:DateTimeReceived"),
  fieldURI("message:InternetMessageId"),
  fieldURI("message:References"),
  fieldURI("item:InReplyTo"),
  fieldURI("item:HasAttachments"),
  fieldURI("item:Importance"),
  fieldURI("item:ItemClass"),
  fieldURI("item:Size"),
  fieldURI("item:InternetMessageHeaders"),
];

const VERSION_FALLBACKS = ["Exchange2013_SP1", "Exchange2010_SP2", "Exchange2010_SP1", "Exchange2007_SP1"];
const VERSION_ERRORS = new Set([
  "ErrorInvalidServerVersion",
  "ErrorIncorrectSchemaVersion",
  "ErrorInvalidSchemaVersionForMailboxVersion",
]);
const TRANSIENT_ERRORS = new Set(["ErrorServerBusy", "ErrorInternalServerTransientError", "ErrorTimeoutExpired", "ErrorMailboxStoreUnavailable", "ErrorConnectionFailed"]);

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

export class EwsClient {
  /**
   * @param {object} opts
   * @param {string} opts.url  EWS endpoint (…/EWS/Exchange.asmx)
   * @param {object} opts.transport
   * @param {string} [opts.version]
   * @param {object} [opts.log]
   * @param {Function} [opts.setTimeout]
   */
  constructor({ url, transport, version = VERSION_FALLBACKS[0], log = null, setTimeout = globalThis.setTimeout, mailbox = null }) {
    this.url = url;
    this.transport = transport;
    this.version = version;
    this.log = log;
    this.setTimeout = setTimeout;
    this.serverVersion = null;
    this.mailbox = mailbox; // primary SMTP address, for delegate folder refs
    this.requestCount = 0;
  }

  /** Low-level SOAP call. Returns the parsed *Response element. */
  async call(bodyXml, { attempt = 0, timeZone = null } = {}) {
    const xml = envelope(bodyXml, { version: this.version, timeZone });
    const op = /^<m:(\w+)/.exec(bodyXml)?.[1] || "?";
    this.requestCount++;
    this.log?.debug(`EWS → ${op}`);
    let res;
    try {
      res = await this.transport.request({
        method: "POST",
        url: this.url,
        headers: { "Content-Type": "text/xml; charset=utf-8", Accept: "text/xml" },
        body: xml,
      });
    } catch (e) {
      if (e instanceof EwsAuthError || attempt >= 2) {
        throw e;
      }
      this.log?.warn(`EWS ${op} failed (${e.message}), retrying`);
      await sleep(1000 * (attempt + 1), this.setTimeout);
      return this.call(bodyXml, { attempt: attempt + 1, timeZone });
    }
    if (res.status == 401) {
      throw new EwsAuthError("The server rejected the credentials (HTTP 401).", { status: 401 });
    }
    if (res.status == 403) {
      throw new EwsHttpError(403, "Access to EWS is forbidden for this account (HTTP 403). EWS may be disabled for your mailbox.");
    }
    if ((res.status == 503 || res.status == 502 || res.status == 504) && attempt < 3) {
      await sleep(2000 * (attempt + 1), this.setTimeout);
      return this.call(bodyXml, { attempt: attempt + 1, timeZone });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new EwsHttpError(res.status, `Redirected to ${res.headers?.location || "?"} — check the EWS URL.`);
    }
    if (res.status == 404) {
      throw new EwsHttpError(404, "No EWS service at this URL (HTTP 404).");
    }
    let parsed;
    try {
      parsed = parseEnvelope(res.status, res.body);
    } catch (e) {
      if (e instanceof EwsError && VERSION_ERRORS.has(e.code)) {
        const idx = VERSION_FALLBACKS.indexOf(this.version);
        if (idx >= 0 && idx + 1 < VERSION_FALLBACKS.length) {
          this.version = VERSION_FALLBACKS[idx + 1];
          this.log?.info(`Server rejected schema version, falling back to ${this.version}`);
          return this.call(bodyXml, { attempt, timeZone });
        }
      }
      if (e instanceof EwsError && TRANSIENT_ERRORS.has(e.code) && attempt < 4) {
        const wait = Math.min(e.backOffMs || 2000 * (attempt + 1), 30000);
        this.log?.warn(`EWS ${op}: ${e.code}, backing off ${wait} ms`);
        await sleep(wait, this.setTimeout);
        return this.call(bodyXml, { attempt: attempt + 1, timeZone });
      }
      throw e;
    }
    if (parsed.serverVersion) {
      this.serverVersion = parsed.serverVersion;
    }
    // Throttling can also be reported per message.
    const msgs = responseMessages(parsed.body);
    const busy = msgs.find(m => m.childText("ResponseCode") == "ErrorServerBusy");
    if (busy && attempt < 4) {
      const backOff = parseInt(busy.find("Value")?.text, 10);
      const wait = Math.min(Number.isFinite(backOff) ? backOff : 2000 * (attempt + 1), 30000);
      this.log?.warn(`EWS ${op}: throttled, backing off ${wait} ms`);
      await sleep(wait, this.setTimeout);
      return this.call(bodyXml, { attempt: attempt + 1, timeZone });
    }
    return parsed.body;
  }

  /** Call and return the (checked) response messages. */
  async callMessages(bodyXml, opts = {}) {
    const response = await this.call(bodyXml, opts);
    const msgs = responseMessages(response);
    if (!opts.partial) {
      msgs.forEach(m => checkMessage(m, opts));
    }
    return msgs;
  }

  get isExchange2013OrLater() {
    return !this.serverVersion || this.serverVersion.major >= 15;
  }

  // -------------------------------------------------------------------------
  // Folders

  static FOLDER_PROPS = [
    fieldURI("folder:DisplayName"),
    fieldURI("folder:ParentFolderId"),
    fieldURI("folder:FolderClass"),
    fieldURI("folder:TotalCount"),
    fieldURI("folder:ChildFolderCount"),
    fieldURI("folder:UnreadCount"),
  ];

  folderShape() {
    return `<m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${EwsClient.FOLDER_PROPS.join("")}</t:AdditionalProperties></m:FolderShape>`;
  }

  /**
   * Get folders by reference ("@inbox" or id). Returns an array aligned
   * with `refs`; missing folders are null.
   */
  async getFolders(refs) {
    const msgs = await this.callMessages(
      `<m:GetFolder>${this.folderShape()}<m:FolderIds>${refs.map(r => folderIdXml(r, this.mailbox)).join("")}</m:FolderIds></m:GetFolder>`,
      { partial: true }
    );
    return msgs.map((m, i) => {
      const err = messageError(m);
      if (err) {
        if (refs.length == 1 && !["ErrorFolderNotFound", "ErrorItemNotFound"].includes(err.code)) {
          throw err;
        }
        return null;
      }
      const el = m.child("Folders")?.elements()[0];
      if (!el) {
        return null;
      }
      const f = parseFolder(el);
      if (typeof refs[i] == "string" && refs[i].startsWith("@")) {
        f.distinguishedId = refs[i].slice(1);
      }
      return f;
    });
  }

  /** Map distinguished name -> folder for all well-known folders that exist. */
  async getDistinguishedFolders() {
    const refs = DISTINGUISHED_FOLDERS.map(n => "@" + n);
    let folders;
    try {
      folders = await this.getFolders(refs);
    } catch (e) {
      // A server whose schema lacks one of the names rejects the whole batch.
      if (e.code != "ErrorSchemaValidation" && e.code != "ErrorInvalidRequest") {
        throw e;
      }
      folders = [];
      for (const r of refs) {
        folders.push((await this.getFolders([r]).catch(() => [null]))[0]);
      }
    }
    const out = {};
    folders.forEach((f, i) => {
      if (f) {
        out[DISTINGUISHED_FOLDERS[i]] = f;
      }
    });
    return out;
  }

  /** All folders below `parent` (deep traversal), with paging. */
  async findFoldersDeep(parent = "@msgfolderroot") {
    const out = [];
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const [msg] = await this.callMessages(
        `<m:FindFolder Traversal="Deep">${this.folderShape()}` +
          `<m:IndexedPageFolderView MaxEntriesReturned="500" Offset="${offset}" BasePoint="Beginning"/>` +
          `<m:ParentFolderIds>${folderIdXml(parent, this.mailbox)}</m:ParentFolderIds></m:FindFolder>`
      );
      const root = msg.child("RootFolder");
      const folders = root?.child("Folders")?.elements() || [];
      out.push(...folders.map(parseFolder));
      if (!root || root.attr("IncludesLastItemInRange") != "false" || !folders.length) {
        break;
      }
      offset = parseInt(root.attr("IndexedPagingOffset"), 10) || offset + folders.length;
    }
    return out;
  }

  async createFolder(parentRef, displayName, folderClass = "IPF.Note") {
    const kind = folderClass.startsWith("IPF.Appointment")
      ? "t:CalendarFolder"
      : folderClass.startsWith("IPF.Contact")
        ? "t:ContactsFolder"
        : folderClass.startsWith("IPF.Task")
          ? "t:TasksFolder"
          : "t:Folder";
    const [msg] = await this.callMessages(
      `<m:CreateFolder><m:ParentFolderId>${folderIdXml(parentRef, this.mailbox)}</m:ParentFolderId><m:Folders>` +
        tag(kind, [textTag("t:FolderClass", folderClass), textTag("t:DisplayName", displayName)]) +
        `</m:Folders></m:CreateFolder>`
    );
    const el = msg.child("Folders").elements()[0];
    return parseFolder(el);
  }

  async renameFolder(folderId, displayName) {
    await this.callMessages(
      `<m:UpdateFolder><m:FolderChanges><t:FolderChange>${folderIdXml(folderId)}<t:Updates><t:SetFolderField>` +
        `${fieldURI("folder:DisplayName")}<t:Folder>${textTag("t:DisplayName", displayName)}</t:Folder>` +
        `</t:SetFolderField></t:Updates></t:FolderChange></m:FolderChanges></m:UpdateFolder>`
    );
  }

  async moveFolder(folderId, toParentRef) {
    const [msg] = await this.callMessages(
      `<m:MoveFolder><m:ToFolderId>${folderIdXml(toParentRef, this.mailbox)}</m:ToFolderId>` +
        `<m:FolderIds>${folderIdXml(folderId)}</m:FolderIds></m:MoveFolder>`
    );
    const el = msg.child("Folders")?.elements()[0];
    return el ? parseFolder(el) : null;
  }

  async deleteFolder(folderId, deleteType = "SoftDelete") {
    await this.callMessages(`<m:DeleteFolder DeleteType="${deleteType}"><m:FolderIds>${folderIdXml(folderId)}</m:FolderIds></m:DeleteFolder>`);
  }

  // -------------------------------------------------------------------------
  // Items

  itemShape({ base = "IdOnly", props = [], mime = false, bodyType = null } = {}) {
    return (
      `<m:ItemShape><t:BaseShape>${base}</t:BaseShape>` +
      (mime ? `<t:IncludeMimeContent>true</t:IncludeMimeContent>` : "") +
      (bodyType ? `<t:BodyType>${bodyType}</t:BodyType>` : "") +
      (props.length ? `<t:AdditionalProperties>${props.join("")}</t:AdditionalProperties>` : "") +
      `</m:ItemShape>`
    );
  }

  /**
   * One page of incremental item changes for a folder.
   * Returns { syncState, includesLast, changes: [{ type, item? , id, changeKey, isRead? }] }
   * type ∈ create | update | delete | readflag
   */
  async syncFolderItems(folderRef, syncState, { props = MAIL_SYNC_PROPS, max = 512 } = {}) {
    const [msg] = await this.callMessages(
      `<m:SyncFolderItems>${this.itemShape({ props })}` +
        `<m:SyncFolderId>${folderIdXml(folderRef, this.mailbox)}</m:SyncFolderId>` +
        (syncState ? `<m:SyncState>${xmlEscape(syncState)}</m:SyncState>` : "") +
        `<m:MaxChangesReturned>${max}</m:MaxChangesReturned>` +
        `<m:SyncScope>NormalItems</m:SyncScope></m:SyncFolderItems>`
    );
    const changes = [];
    for (const c of msg.child("Changes")?.elements() || []) {
      if (c.name == "Create" || c.name == "Update") {
        const itemEl = c.elements()[0];
        if (!itemEl) {
          continue;
        }
        const item = parseItem(itemEl);
        changes.push({ type: c.name.toLowerCase(), id: item.id, changeKey: item.changeKey, item });
      } else if (c.name == "Delete") {
        changes.push({ type: "delete", id: c.child("ItemId")?.attr("Id") });
      } else if (c.name == "ReadFlagChange") {
        changes.push({ type: "readflag", id: c.child("ItemId")?.attr("Id"), isRead: c.childText("IsRead") == "true" });
      }
    }
    return {
      syncState: msg.childText("SyncState"),
      includesLast: msg.childText("IncludesLastItemInRange") != "false",
      changes,
    };
  }

  /**
   * GetItem for many ids (batched). Returns array aligned with ids; items
   * that no longer exist are null.
   */
  async getItems(ids, { props = [], mime = false, base = "IdOnly", bodyType = null, batch = mime ? 10 : 100 } = {}) {
    const out = [];
    for (const group of chunks(ids, batch)) {
      const msgs = await this.callMessages(
        `<m:GetItem>${this.itemShape({ base, props, mime, bodyType })}<m:ItemIds>${group.map(id => itemIdXml(id)).join("")}</m:ItemIds></m:GetItem>`,
        { partial: true }
      );
      msgs.forEach(m => {
        const err = messageError(m);
        if (err) {
          if (err.code != "ErrorItemNotFound" && err.code != "ErrorInvalidId" && err.code != "ErrorInvalidIdMalformed") {
            throw err;
          }
          out.push(null);
          return;
        }
        const el = m.child("Items")?.elements()[0];
        out.push(el ? parseItem(el) : null);
      });
    }
    return out;
  }

  /** Full MIME content of one item as a binary string (null if gone). */
  async getMime(id) {
    const [item] = await this.getItems([id], { mime: true });
    if (!item) {
      return null;
    }
    if (!item.mime) {
      throw new EwsError("NoMimeContent", "Server returned no MIME content for this item");
    }
    return base64Decode(item.mime);
  }

  /**
   * Store a MIME message in a folder (or send it).
   * @returns {Promise<{id, changeKey}|null>} null when sending without a saved copy id.
   */
  async createItemFromMime(mimeBin, { folder = "@drafts", disposition = "SaveOnly", messageFlags = null, isRead = null, extra = "" } = {}) {
    const props = [];
    if (messageFlags !== null) {
      props.push(extProperty(PROP.MESSAGE_FLAGS, messageFlags));
    }
    let message = `<t:MimeContent CharacterSet="UTF-8">${base64Encode(mimeBin)}</t:MimeContent>` + props.join("") + extra;
    if (isRead !== null) {
      message += textTag("t:IsRead", isRead ? "true" : "false");
    }
    const [msg] = await this.callMessages(
      `<m:CreateItem MessageDisposition="${disposition}">` +
        `<m:SavedItemFolderId>${folderIdXml(folder, this.mailbox)}</m:SavedItemFolderId>` +
        `<m:Items><t:Message>${message}</t:Message></m:Items></m:CreateItem>`
    );
    const idEl = msg.child("Items")?.elements()[0]?.child("ItemId");
    return idEl ? { id: idEl.attr("Id"), changeKey: idEl.attr("ChangeKey") } : null;
  }

  /** Generic CreateItem with caller-supplied item XML. Returns created ids. */
  async createItems(itemsXml, { folder = null, disposition = null, sendInvitations = null } = {}) {
    const attrs = [];
    if (disposition) {
      attrs.push(`MessageDisposition="${disposition}"`);
    }
    if (sendInvitations) {
      attrs.push(`SendMeetingInvitations="${sendInvitations}"`);
    }
    const msgs = await this.callMessages(
      `<m:CreateItem${attrs.length ? " " + attrs.join(" ") : ""}>` +
        (folder ? `<m:SavedItemFolderId>${folderIdXml(folder, this.mailbox)}</m:SavedItemFolderId>` : "") +
        `<m:Items>${itemsXml}</m:Items></m:CreateItem>`
    );
    return msgs.map(m => {
      const idEl = m.child("Items")?.elements()[0]?.child("ItemId");
      return idEl ? { id: idEl.attr("Id"), changeKey: idEl.attr("ChangeKey") } : null;
    });
  }

  /**
   * UpdateItem. `changes` = [{ id, changeKey?, kind: "Message", set: [xml...], del: [uriXml...] }]
   * A `set` entry is the full <t:SetItemField> element body: fieldUri + item element.
   * Returns new {id, changeKey} per change (null for failures when partial).
   */
  async updateItems(changes, { conflict = "AlwaysOverwrite", disposition = "SaveOnly", sendUpdates = null, partial = false } = {}) {
    const results = [];
    for (const group of chunks(changes, 50)) {
      const body = group
        .map(
          c =>
            `<t:ItemChange>${itemIdXml(c.changeKey ? { id: c.id, changeKey: c.changeKey } : c.id)}<t:Updates>` +
            (c.set || []).map(s => `<t:SetItemField>${s}</t:SetItemField>`).join("") +
            (c.append || []).map(s => `<t:AppendToItemField>${s}</t:AppendToItemField>`).join("") +
            (c.del || []).map(d => `<t:DeleteItemField>${d}</t:DeleteItemField>`).join("") +
            `</t:Updates></t:ItemChange>`
        )
        .join("");
      const attrs = `MessageDisposition="${disposition}" ConflictResolution="${conflict}"` +
        (sendUpdates ? ` SendMeetingInvitationsOrCancellations="${sendUpdates}"` : "");
      const msgs = await this.callMessages(`<m:UpdateItem ${attrs}><m:ItemChanges>${body}</m:ItemChanges></m:UpdateItem>`, { partial: true });
      for (const m of msgs) {
        const err = messageError(m);
        if (err) {
          if (!partial) {
            throw err;
          }
          results.push(null);
          continue;
        }
        const idEl = m.child("Items")?.elements()[0]?.child("ItemId");
        results.push(idEl ? { id: idEl.attr("Id"), changeKey: idEl.attr("ChangeKey") } : {});
      }
    }
    return results;
  }

  /** SetItemField body for a first-class property. */
  static setField(uri, kind, innerXml) {
    return `${fieldURI(uri)}<t:${kind}>${innerXml}</t:${kind}>`;
  }

  /** SetItemField body for an extended property. */
  static setExtended(prop, kind, value) {
    return `${extFieldURI(prop)}<t:${kind}>${extProperty(prop, value)}</t:${kind}>`;
  }

  async moveItems(ids, toFolder) {
    return this.#moveOrCopy("MoveItem", ids, toFolder);
  }

  async copyItems(ids, toFolder) {
    return this.#moveOrCopy("CopyItem", ids, toFolder);
  }

  async #moveOrCopy(op, ids, toFolder) {
    const out = [];
    for (const group of chunks(ids, 100)) {
      const msgs = await this.callMessages(
        `<m:${op}><m:ToFolderId>${folderIdXml(toFolder, this.mailbox)}</m:ToFolderId>` +
          `<m:ItemIds>${group.map(id => itemIdXml(id)).join("")}</m:ItemIds>` +
          `<m:ReturnNewItemIds>true</m:ReturnNewItemIds></m:${op}>`,
        { partial: true }
      );
      for (const m of msgs) {
        const err = messageError(m);
        if (err) {
          if (err.code == "ErrorItemNotFound") {
            out.push(null);
            continue;
          }
          throw err;
        }
        const idEl = m.child("Items")?.elements()[0]?.child("ItemId");
        out.push(idEl ? { id: idEl.attr("Id"), changeKey: idEl.attr("ChangeKey") } : {});
      }
    }
    return out;
  }

  async deleteItems(ids, { deleteType = "SoftDelete", cancellations = "SendToNone" } = {}) {
    for (const group of chunks(ids, 100)) {
      const msgs = await this.callMessages(
        `<m:DeleteItem DeleteType="${deleteType}" SendMeetingCancellations="${cancellations}" AffectedTaskOccurrences="AllOccurrences">` +
          `<m:ItemIds>${group.map(id => itemIdXml(id)).join("")}</m:ItemIds></m:DeleteItem>`,
        { partial: true }
      );
      for (const m of msgs) {
        const err = messageError(m);
        if (err && err.code != "ErrorItemNotFound") {
          throw err;
        }
      }
    }
  }

  /**
   * FindItem (shallow) with an optional restriction; returns all pages.
   * `view` may be a CalendarView element string instead of paging.
   */
  async findItems(folderRef, { restriction = null, props = [], max = 10000, calendarView = null, sort = null } = {}) {
    const out = [];
    let offset = 0;
    for (;;) {
      const view = calendarView || `<m:IndexedPageItemView MaxEntriesReturned="${Math.min(500, max - out.length)}" Offset="${offset}" BasePoint="Beginning"/>`;
      const [msg] = await this.callMessages(
        `<m:FindItem Traversal="Shallow">${this.itemShape({ props })}${view}` +
          (restriction ? `<m:Restriction>${restriction}</m:Restriction>` : "") +
          (sort ? `<m:SortOrder>${sort}</m:SortOrder>` : "") +
          `<m:ParentFolderIds>${folderIdXml(folderRef, this.mailbox)}</m:ParentFolderIds></m:FindItem>`
      );
      const root = msg.child("RootFolder");
      const items = root?.child("Items")?.elements() || [];
      out.push(...items.map(parseItem));
      if (calendarView || !root || root.attr("IncludesLastItemInRange") != "false" || !items.length || out.length >= max) {
        break;
      }
      offset = parseInt(root.attr("IndexedPagingOffset"), 10) || offset + items.length;
    }
    return out;
  }

  /**
   * Resolve names against the GAL and contacts.
   * Returns [{ name, email, contact: XmlElement|null }]
   */
  async resolveNames(query, { fullContactData = true, scope = "ActiveDirectoryContacts" } = {}) {
    const response = await this.call(
      `<m:ResolveNames ReturnFullContactData="${fullContactData}" SearchScope="${scope}">` +
        `<m:UnresolvedEntry>${xmlEscape(query)}</m:UnresolvedEntry></m:ResolveNames>`
    );
    const [msg] = responseMessages(response);
    if (!msg) {
      return [];
    }
    const code = msg.childText("ResponseCode");
    if (code == "ErrorNameResolutionNoResults") {
      return [];
    }
    checkMessage(msg);
    return (msg.child("ResolutionSet")?.elements("Resolution") || []).map(r => {
      const mb = parseMailbox(r.child("Mailbox"));
      return { ...mb, contact: r.child("Contact") };
    });
  }

  /** Respond to a meeting request/calendar item. kind: AcceptItem | TentativelyAcceptItem | DeclineItem */
  async respondToMeeting(kind, ref, { send = true, body = null } = {}) {
    // Schema order: inherited Item fields (Body) precede ReferenceItemId.
    const inner = (body ? `<t:Body BodyType="Text">${xmlEscape(body)}</t:Body>` : "") + itemIdXml(ref, "t:ReferenceItemId");
    await this.createItems(tag(`t:${kind}`, inner), { disposition: send ? "SendAndSaveCopy" : "SaveOnly" });
  }

  /** Cheap authenticated probe: fetch the Inbox. Returns {folder, serverVersion}. */
  async probe() {
    const [inbox] = await this.getFolders(["@inbox"]);
    return { inbox, serverVersion: this.serverVersion, version: this.version };
  }
}


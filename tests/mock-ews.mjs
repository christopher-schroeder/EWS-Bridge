/* In-memory Exchange Web Services mock for tests.
 * Implements the subset of EWS semantics the gateway relies on. It is not a
 * schema validator, but it does enforce the element *order* of item fields we
 * emit (see ORDER below), since real Exchange rejects out-of-order XML.
 */

import { parseXml, xmlEscape, XmlElement } from "../core/xml.mjs";
import { base64Decode, base64Encode, utf8Decode } from "../core/util.mjs";
import { parseMime, parseAddressList, decodeHeaderValue } from "../core/mime.mjs";

const T = "t:";

export function serialize(el, prefix = T) {
  if (typeof el == "string") return xmlEscape(el);
  const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${xmlEscape(v)}"`).join("");
  const inner = el.children.map(c => serialize(c, prefix)).join("");
  return inner ? `<${prefix}${el.name}${attrs}>${inner}</${prefix}${el.name}>` : `<${prefix}${el.name}${attrs}/>`;
}

// Schema sequence for the item fields the bridge writes (subset of types.xsd).
const ITEM_ORDER = ["MimeContent", "ItemId", "ParentFolderId", "ItemClass", "Subject", "Sensitivity", "Body", "Attachments", "DateTimeReceived", "Size", "Categories", "Importance", "InReplyTo", "IsSubmitted", "IsDraft", "IsFromMe", "IsResend", "IsUnmodified", "InternetMessageHeaders", "DateTimeSent", "DateTimeCreated", "ResponseObjects", "ReminderDueBy", "ReminderIsSet", "ReminderMinutesBeforeStart", "DisplayCc", "DisplayTo", "HasAttachments", "ExtendedProperty", "Culture"];
const ORDER = {
  Message: [...ITEM_ORDER, "Sender", "ToRecipients", "CcRecipients", "BccRecipients", "IsReadReceiptRequested", "IsDeliveryReceiptRequested", "ConversationIndex", "ConversationTopic", "From", "InternetMessageId", "IsRead", "IsResponseRequested", "References", "ReplyTo", "ReceivedBy", "ReceivedRepresenting"],
  CalendarItem: [...ITEM_ORDER, "UID", "RecurrenceId", "DateTimeStamp", "Start", "End", "OriginalStart", "IsAllDayEvent", "LegacyFreeBusyStatus", "Location", "When", "IsMeeting", "IsCancelled", "IsRecurring", "MeetingRequestWasSent", "IsResponseRequested", "CalendarItemType", "MyResponseType", "Organizer", "RequiredAttendees", "OptionalAttendees", "Resources", "ConflictingMeetingCount", "AdjacentMeetingCount", "ConflictingMeetings", "AdjacentMeetings", "Duration", "TimeZone", "AppointmentReplyTime", "AppointmentSequenceNumber", "AppointmentState", "Recurrence", "FirstOccurrence", "LastOccurrence", "ModifiedOccurrences", "DeletedOccurrences", "MeetingTimeZone", "StartTimeZone", "EndTimeZone"],
  Contact: [...ITEM_ORDER, "FileAs", "FileAsMapping", "DisplayName", "GivenName", "Initials", "MiddleName", "Nickname", "CompleteName", "CompanyName", "EmailAddresses", "PhysicalAddresses", "PhoneNumbers", "AssistantName", "Birthday", "BusinessHomePage", "Children", "Companies", "ContactSource", "Department", "Generation", "ImAddresses", "JobTitle", "Manager", "Mileage", "OfficeLocation", "PostalAddressIndex", "Profession", "SpouseName", "Surname", "WeddingAnniversary", "HasPicture", "PhoneticFullName", "PhoneticFirstName", "PhoneticLastName", "Alias", "Notes"],
};

function checkOrder(el) {
  const order = ORDER[el.name];
  if (!order) return;
  let last = -1;
  for (const c of el.elements()) {
    const i = order.indexOf(c.name);
    if (i < 0) throw new SchemaError(`Unknown element ${c.name} in ${el.name}`);
    if (i < last) throw new SchemaError(`Element ${c.name} out of schema order in ${el.name}`);
    last = i;
  }
}

class SchemaError extends Error {}

let counter = 0;
const newId = kind => base64Encode(`AAMk${kind}${++counter}${"x".repeat(40)}`);

export class MockExchange {
  constructor({ email = "user@example.org", username = "user", password = "secret", name = "Test User" } = {}) {
    this.email = email;
    this.username = username;
    this.password = password;
    this.displayName = name;
    this.folders = new Map();
    this.items = new Map();
    this.seq = 0;
    this.log = new Map(); // folderId -> [{seq, type, id}]
    this.hierarchySeq = 0;
    this.sent = [];
    this.responses = [];
    this.directory = [];
    this.requests = [];
    this.failNext = null;
    const root = this.#mkFolder(null, "Top of Information Store", "IPF.Note", "msgfolderroot");
    this.root = root;
    for (const [d, n, cls] of [
      ["inbox", "Inbox", "IPF.Note"],
      ["drafts", "Drafts", "IPF.Note"],
      ["sentitems", "Sent Items", "IPF.Note"],
      ["deleteditems", "Deleted Items", "IPF.Note"],
      ["junkemail", "Junk Email", "IPF.Note"],
      ["outbox", "Outbox", "IPF.Note"],
      ["calendar", "Calendar", "IPF.Appointment"],
      ["contacts", "Contacts", "IPF.Contact"],
      ["tasks", "Tasks", "IPF.Task"],
    ]) {
      this.#mkFolder(root.id, n, cls, d);
    }
  }

  #mkFolder(parentId, displayName, folderClass, distinguished = null) {
    const f = { id: newId("F"), changeKey: "CK" + ++this.seq, parentId, displayName, folderClass, distinguished };
    this.folders.set(f.id, f);
    this.log.set(f.id, []);
    return f;
  }

  folder(name) {
    for (const f of this.folders.values()) if (f.distinguished == name || f.displayName == name) return f;
    return null;
  }

  #record(folderId, type, id) {
    this.log.get(folderId)?.push({ seq: ++this.seq, type, id });
  }

  /** Test helper: deliver a MIME message into a folder. */
  addMessage(folderName, mime, { isRead = false, flagged = false, received = new Date() } = {}) {
    const f = this.folder(folderName);
    const item = this.#messageFromMime(f.id, mime, { isRead, received });
    if (flagged) item.ext["0x1090"] = "2";
    this.#record(f.id, "create", item.id);
    return item;
  }

  #messageFromMime(folderId, mime, { isRead = false, received = new Date(), ext = {} } = {}) {
    const root = parseMime(mime);
    const h = root.headers;
    const mbx = list => list.map(a => `<t:Mailbox><t:Name>${xmlEscape(a.name || a.email)}</t:Name><t:EmailAddress>${xmlEscape(a.email)}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox>`).join("");
    const props = new Map();
    props.set("ItemClass", `<t:ItemClass>IPM.Note</t:ItemClass>`);
    props.set("Subject", `<t:Subject>${xmlEscape(decodeHeaderValue(h.get("Subject") || ""))}</t:Subject>`);
    const from = parseAddressList(h.get("From"));
    if (from.length) props.set("From", `<t:From>${mbx(from)}</t:From>`);
    for (const [hdr, el] of [["To", "ToRecipients"], ["Cc", "CcRecipients"]]) {
      const l = parseAddressList(h.get(hdr));
      if (l.length) props.set(el, `<t:${el}>${mbx(l)}</t:${el}>`);
    }
    if (h.get("Message-ID")) props.set("InternetMessageId", `<t:InternetMessageId>${xmlEscape(h.get("Message-ID"))}</t:InternetMessageId>`);
    if (h.get("Date")) props.set("DateTimeSent", `<t:DateTimeSent>${new Date(h.get("Date")).toISOString().replace(/\.\d+Z$/, "Z")}</t:DateTimeSent>`);
    props.set("DateTimeReceived", `<t:DateTimeReceived>${received.toISOString().replace(/\.\d+Z$/, "Z")}</t:DateTimeReceived>`);
    props.set("HasAttachments", `<t:HasAttachments>${root.type == "multipart" && root.subtype == "mixed"}</t:HasAttachments>`);
    props.set("Size", `<t:Size>${mime.length + 137}</t:Size>`); // deliberately != MIME size, like Exchange
    const item = { id: newId("I"), changeKey: "CQ" + ++this.seq, folderId, kind: "Message", props, mime, isRead, ext: { ...ext } };
    if (ext["0x0E07"] !== undefined) {
      item.isRead = (parseInt(ext["0x0E07"], 10) & 1) == 1;
      if (parseInt(ext["0x0E07"], 10) & 8) props.set("IsDraft", "<t:IsDraft>true</t:IsDraft>");
    }
    this.items.set(item.id, item);
    return item;
  }

  itemsIn(folderName) {
    const f = this.folder(folderName);
    return [...this.items.values()].filter(i => i.folderId == f.id);
  }

  // ---------------------------------------------------------------- HTTP

  async fetchHandler(req) {
    const auth = req.headers.get("authorization") || "";
    const expected = "Basic " + btoa(`${this.username}:${this.password}`);
    if (auth != expected) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="mock"' } });
    }
    const url = new URL(req.url);
    const text = await req.text();
    if (url.pathname.toLowerCase() == "/autodiscover/autodiscover.xml") {
      return new Response(this.autodiscover(url.origin), { headers: { "Content-Type": "text/xml" } });
    }
    const { status, body } = this.handle(text);
    return new Response(body, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
  }

  serve(port = 0) {
    const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, req => this.fetchHandler(req));
    this.server = server;
    this.url = `http://127.0.0.1:${server.addr.port}/EWS/Exchange.asmx`;
    return server;
  }

  autodiscover(origin) {
    return `<?xml version="1.0"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006"><Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a"><User><DisplayName>${xmlEscape(this.displayName)}</DisplayName><AutoDiscoverSMTPAddress>${this.email}</AutoDiscoverSMTPAddress></User><Account><AccountType>email</AccountType><Action>settings</Action><Protocol><Type>EXCH</Type><EwsUrl>${origin}/EWS/Exchange.asmx</EwsUrl></Protocol></Account></Response></Autodiscover>`;
  }

  handle(text) {
    let op = "?";
    try {
      const env = parseXml(text);
      const body = env.child("Body").elements()[0];
      op = body.name;
      this.requests.push(op);
      if (this.failNext && this.failNext.op == op) {
        const f = this.failNext;
        this.failNext = null;
        return { status: 500, body: fault(f.code, f.message || "injected") };
      }
      const fn = this["op" + op];
      if (!fn) return { status: 500, body: fault("ErrorInvalidRequest", `Mock does not implement ${op}`) };
      const inner = fn.call(this, body);
      return {
        status: 200,
        body: `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><h:ServerVersionInfo MajorVersion="15" MinorVersion="2" MajorBuildNumber="2562" MinorBuildNumber="49" xmlns:h="http://schemas.microsoft.com/exchange/services/2006/types"/></s:Header><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:${op}Response><m:ResponseMessages>${inner}</m:ResponseMessages></m:${op}Response></s:Body></s:Envelope>`,
      };
    } catch (e) {
      if (e instanceof SchemaError) return { status: 500, body: fault("ErrorSchemaValidation", e.message) };
      return { status: 500, body: fault("ErrorInternalServerError", `${op}: ${e.message}\n${e.stack}`) };
    }
  }

  // ---------------------------------------------------------------- helpers

  #resolveFolder(el) {
    const ref = el.elements()[0];
    if (ref.name == "DistinguishedFolderId") return this.folder(ref.attr("Id"));
    return this.folders.get(ref.attr("Id")) || null;
  }

  #folderXml(f) {
    const kind = f.folderClass.startsWith("IPF.Appointment") ? "CalendarFolder" : f.folderClass.startsWith("IPF.Contact") ? "ContactsFolder" : f.folderClass.startsWith("IPF.Task") ? "TasksFolder" : "Folder";
    const items = [...this.items.values()].filter(i => i.folderId == f.id);
    const kids = [...this.folders.values()].filter(c => c.parentId == f.id).length;
    return `<t:${kind}><t:FolderId Id="${f.id}" ChangeKey="${f.changeKey}"/>${f.parentId ? `<t:ParentFolderId Id="${f.parentId}"/>` : ""}<t:FolderClass>${f.folderClass}</t:FolderClass><t:DisplayName>${xmlEscape(f.displayName)}</t:DisplayName><t:TotalCount>${items.length}</t:TotalCount><t:ChildFolderCount>${kids}</t:ChildFolderCount><t:UnreadCount>${items.filter(i => !i.isRead).length}</t:UnreadCount></t:${kind}>`;
  }

  #itemXml(item, shape) {
    const base = shape?.childText("BaseShape") || "IdOnly";
    const mime = shape?.childText("IncludeMimeContent") == "true";
    const wanted = new Set();
    const wantedExt = new Set();
    const wantedNamed = new Set();
    for (const p of shape?.child("AdditionalProperties")?.elements() || []) {
      if (p.name == "FieldURI") wanted.add(p.attr("FieldURI").split(":").pop());
      if (p.name == "ExtendedFieldURI" && p.attr("PropertyTag")) wantedExt.add(normTag(p.attr("PropertyTag")));
      if (p.name == "ExtendedFieldURI" && p.attr("PropertyName")) wantedNamed.add(p.attr("PropertyName"));
      if (p.name == "IndexedFieldURI") wanted.add({ EmailAddress: "EmailAddresses", PhoneNumber: "PhoneNumbers", PhysicalAddress: "PhysicalAddresses" }[p.attr("FieldURI").split(":")[1]]);
    }
    let x = "";
    if (mime && item.mime !== undefined) x += `<t:MimeContent CharacterSet="UTF-8">${base64Encode(item.mime)}</t:MimeContent>`;
    x += `<t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/><t:ParentFolderId Id="${item.folderId}"/>`;
    for (const [name, xml] of item.props) {
      if (base == "AllProperties" || wanted.has(name)) x += xml;
    }
    if ((base == "AllProperties" || wanted.has("IsRead")) && item.kind != "CalendarItem" && item.kind != "Contact") x += `<t:IsRead>${item.isRead}</t:IsRead>`;
    if (item.kind == "CalendarItem" && (base == "AllProperties" || wanted.has("ModifiedOccurrences")) && item.exceptions?.length) {
      x += `<t:ModifiedOccurrences>${item.exceptions.map(e => { const ex = this.items.get(e.id); return `<t:Occurrence><t:ItemId Id="${e.id}" ChangeKey="${ex?.changeKey}"/><t:Start>${propText(ex, "Start")}</t:Start><t:End>${propText(ex, "End")}</t:End><t:OriginalStart>${iso(e.originalStart)}</t:OriginalStart></t:Occurrence>`; }).join("")}</t:ModifiedOccurrences>`;
    }
    if (item.kind == "CalendarItem" && (base == "AllProperties" || wanted.has("DeletedOccurrences")) && item.deletedOcc?.length) {
      x += `<t:DeletedOccurrences>${item.deletedOcc.map(d => `<t:DeletedOccurrence><t:Start>${iso(d)}</t:Start></t:DeletedOccurrence>`).join("")}</t:DeletedOccurrences>`;
    }
    for (const [n, v] of Object.entries(item.named || {})) {
      if (wantedNamed.has(n)) x += `<t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="PublicStrings" PropertyName="${n}" PropertyType="String"/><t:Value>${xmlEscape(v)}</t:Value></t:ExtendedProperty>`;
    }
    if (item.originalStart && (base == "AllProperties" || wanted.has("OriginalStart"))) {
      x += `<t:OriginalStart>${iso(item.originalStart)}</t:OriginalStart>`;
    }
    for (const [tagName, v] of Object.entries(item.ext)) {
      if (wantedExt.has(tagName)) x += `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="${tagName}" PropertyType="Integer"/><t:Value>${v}</t:Value></t:ExtendedProperty>`;
    }
    return `<t:${item.kind}>${x}</t:${item.kind}>`;
  }

  #bump(item, type = "update") {
    item.changeKey = "CQ" + ++this.seq;
    this.#record(item.folderId, type, item.id);
  }

  // ---------------------------------------------------------------- folders

  opGetFolder(body) {
    return body.child("FolderIds").elements().map(ref => {
      const f = ref.name == "DistinguishedFolderId" ? this.folder(ref.attr("Id")) : this.folders.get(ref.attr("Id"));
      if (!f) return errMsg("GetFolder", "ErrorFolderNotFound", "The specified folder could not be found in the store.");
      return okMsg("GetFolder", `<m:Folders>${this.#folderXml(f)}</m:Folders>`);
    }).join("");
  }

  opFindFolder(body) {
    const parent = this.#resolveFolder(body.child("ParentFolderIds"));
    const deep = body.attr("Traversal") == "Deep";
    const out = [];
    const walk = pid => {
      for (const f of this.folders.values()) {
        if (f.parentId == pid) {
          out.push(f);
          if (deep) walk(f.id);
        }
      }
    };
    walk(parent.id);
    const view = body.child("IndexedPageFolderView");
    const offset = parseInt(view?.attr("Offset") || "0", 10);
    const max = parseInt(view?.attr("MaxEntriesReturned") || "1000", 10);
    const page = out.slice(offset, offset + max);
    const last = offset + page.length >= out.length;
    return okMsg("FindFolder", `<m:RootFolder IndexedPagingOffset="${offset + page.length}" TotalItemsInView="${out.length}" IncludesLastItemInRange="${last}"><t:Folders>${page.map(f => this.#folderXml(f)).join("")}</t:Folders></m:RootFolder>`);
  }

  opCreateFolder(body) {
    const parent = this.#resolveFolder(body.child("ParentFolderId"));
    return body.child("Folders").elements().map(fe => {
      const name = fe.childText("DisplayName");
      if ([...this.folders.values()].some(f => f.parentId == parent.id && f.displayName == name)) return errMsg("CreateFolder", "ErrorFolderExists", "A folder with the specified name already exists.");
      const f = this.#mkFolder(parent.id, name, fe.childText("FolderClass") || "IPF.Note");
      this.hierarchySeq++;
      return okMsg("CreateFolder", `<m:Folders>${this.#folderXml(f)}</m:Folders>`);
    }).join("");
  }

  opUpdateFolder(body) {
    return body.child("FolderChanges").elements().map(fc => {
      const f = this.folders.get(fc.child("FolderId").attr("Id"));
      if (!f) return errMsg("UpdateFolder", "ErrorFolderNotFound", "");
      const set = fc.child("Updates").child("SetFolderField");
      f.displayName = set.find("DisplayName").text;
      f.changeKey = "CK" + ++this.seq;
      return okMsg("UpdateFolder", `<m:Folders>${this.#folderXml(f)}</m:Folders>`);
    }).join("");
  }

  opMoveFolder(body) {
    const to = this.#resolveFolder(body.child("ToFolderId"));
    return body.child("FolderIds").elements().map(ref => {
      const f = this.folders.get(ref.attr("Id"));
      if (!f) return errMsg("MoveFolder", "ErrorFolderNotFound", "");
      f.parentId = to.id;
      return okMsg("MoveFolder", `<m:Folders>${this.#folderXml(f)}</m:Folders>`);
    }).join("");
  }

  opDeleteFolder(body) {
    return body.child("FolderIds").elements().map(ref => {
      const f = this.folders.get(ref.attr("Id"));
      if (!f) return errMsg("DeleteFolder", "ErrorFolderNotFound", "");
      if (f.distinguished) return errMsg("DeleteFolder", "ErrorDeleteDistinguishedFolder", "Distinguished folders cannot be deleted.");
      const kill = id => {
        for (const c of [...this.folders.values()].filter(c => c.parentId == id)) kill(c.id);
        for (const i of [...this.items.values()].filter(i => i.folderId == id)) this.items.delete(i.id);
        this.folders.delete(id);
      };
      kill(f.id);
      return okMsg("DeleteFolder", "");
    }).join("");
  }

  // ---------------------------------------------------------------- items

  opSyncFolderItems(body) {
    const f = this.#resolveFolder(body.child("SyncFolderId"));
    if (!f) return errMsg("SyncFolderItems", "ErrorFolderNotFound", "");
    const shape = body.child("ItemShape");
    const max = parseInt(body.childText("MaxChangesReturned") || "512", 10);
    const state = body.childText("SyncState");
    let changes = [];
    let newSeq;
    if (!state) {
      const items = [...this.items.values()].filter(i => i.folderId == f.id && !i.masterId);
      const page = items.slice(0, max);
      // initial sync: pretend a full enumeration; the new state is "now"
      changes = page.map(i => `<t:Create>${this.#itemXml(i, shape)}</t:Create>`);
      const includesLast = items.length <= max;
      newSeq = includesLast ? this.seq : `init:${page.length}`;
      if (!includesLast) {
        return okMsg("SyncFolderItems", `<m:SyncState>${newSeq}@${this.seq}</m:SyncState><m:IncludesLastItemInRange>false</m:IncludesLastItemInRange><m:Changes>${changes.join("")}</m:Changes>`);
      }
      return okMsg("SyncFolderItems", `<m:SyncState>s${newSeq}</m:SyncState><m:IncludesLastItemInRange>true</m:IncludesLastItemInRange><m:Changes>${changes.join("")}</m:Changes>`);
    }
    if (state.startsWith("init:")) {
      const [, rest] = state.split(":");
      const [done, atSeq] = rest.split("@").map(Number);
      const items = [...this.items.values()].filter(i => i.folderId == f.id && !i.masterId);
      const page = items.slice(done, done + max);
      const includesLast = done + page.length >= items.length;
      changes = page.map(i => `<t:Create>${this.#itemXml(i, shape)}</t:Create>`);
      const next = includesLast ? `s${atSeq}` : `init:${done + page.length}@${atSeq}`;
      return okMsg("SyncFolderItems", `<m:SyncState>${next}</m:SyncState><m:IncludesLastItemInRange>${includesLast}</m:IncludesLastItemInRange><m:Changes>${changes.join("")}</m:Changes>`);
    }
    const since = parseInt(state.slice(1), 10);
    const entries = this.log.get(f.id).filter(e => e.seq > since);
    // collapse per item, preserving order of last change
    const byId = new Map();
    for (const e of entries) {
      const prev = byId.get(e.id);
      let type = e.type;
      if (prev) {
        if (prev.type == "create" && type != "delete") type = "create";
        if (prev.type == "create" && type == "delete") { byId.delete(e.id); continue; }
        byId.delete(e.id);
      }
      byId.set(e.id, { ...e, type });
    }
    const list = [...byId.values()].slice(0, max);
    const includesLast = list.length == byId.size;
    const lastSeq = includesLast ? this.seq : list[list.length - 1].seq;
    for (const e of list) {
      const item = this.items.get(e.id);
      if (e.type == "delete" || !item || item.folderId != f.id) {
        changes.push(`<t:Delete><t:ItemId Id="${e.id}"/></t:Delete>`);
      } else if (e.type == "readflag") {
        changes.push(`<t:ReadFlagChange><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/><t:IsRead>${item.isRead}</t:IsRead></t:ReadFlagChange>`);
      } else {
        const tagName = e.type == "create" ? "Create" : "Update";
        changes.push(`<t:${tagName}>${this.#itemXml(item, shape)}</t:${tagName}>`);
      }
    }
    return okMsg("SyncFolderItems", `<m:SyncState>s${lastSeq}</m:SyncState><m:IncludesLastItemInRange>${includesLast}</m:IncludesLastItemInRange><m:Changes>${changes.join("")}</m:Changes>`);
  }

  opGetItem(body) {
    const shape = body.child("ItemShape");
    return body.child("ItemIds").elements().map(ref => {
      const rid = ref.attr("Id") || "";
      let item = rid.startsWith("occ~") ? this.occurrence(this.items.get(rid.split("~")[1]), Number(rid.split("~")[2])) : this.items.get(rid);
      if (ref.name == "OccurrenceItemId") item = null;
      if (!item) return errMsg("GetItem", "ErrorItemNotFound", "The specified object was not found in the store.");
      return okMsg("GetItem", `<m:Items>${this.#itemXml(item, shape)}</m:Items>`);
    }).join("");
  }

  opCreateItem(body) {
    const disposition = body.attr("MessageDisposition");
    const invitations = body.attr("SendMeetingInvitations");
    const saved = body.child("SavedItemFolderId") ? this.#resolveFolder(body.child("SavedItemFolderId")) : null;
    return body.child("Items").elements().map(el => {
      checkOrder(el);
      if (el.name == "Message") {
        const mime = base64Decode(el.childText("MimeContent"));
        const ext = {};
        for (const ep of el.elements("ExtendedProperty")) ext[normTag(ep.child("ExtendedFieldURI").attr("PropertyTag"))] = ep.childText("Value");
        let folder = saved || this.folder("drafts");
        if (disposition == "SendAndSaveCopy" || disposition == "SendOnly") {
          this.sent.push({ mime, disposition });
          if (disposition == "SendOnly") return okMsg("CreateItem", "<m:Items/>");
          folder = saved || this.folder("sentitems");
          ext["0x0E07"] = "1";
        }
        const item = this.#messageFromMime(folder.id, mime, { ext, isRead: el.childText("IsRead") == "true" });
        if (el.childText("IsRead") !== null) item.isRead = el.childText("IsRead") == "true";
        this.#record(folder.id, "create", item.id);
        return okMsg("CreateItem", `<m:Items><t:Message><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:Message></m:Items>`);
      }
      if (el.name == "CalendarItem" || el.name == "Contact") {
        const folder = saved || this.folder(el.name == "Contact" ? "contacts" : "calendar");
        const props = new Map();
        const named = {};
        for (const c of el.elements()) {
          if (c.name == "ExtendedProperty") {
            const u = c.child("ExtendedFieldURI");
            if (u.attr("PropertyName")) named[u.attr("PropertyName")] = c.childText("Value");
            continue;
          }
          props.set(c.name, serialize(c));
        }
        if (el.name == "CalendarItem") {
          if (!props.has("UID")) props.set("UID", `<t:UID>mock-${++counter}</t:UID>`);
          props.set("Organizer", `<t:Organizer><t:Mailbox><t:Name>${this.displayName}</t:Name><t:EmailAddress>${this.email}</t:EmailAddress></t:Mailbox></t:Organizer>`);
          props.set("CalendarItemType", `<t:CalendarItemType>${props.has("Recurrence") ? "RecurringMaster" : "Single"}</t:CalendarItemType>`);
          props.set("IsMeeting", `<t:IsMeeting>${props.has("RequiredAttendees") || props.has("OptionalAttendees")}</t:IsMeeting>`);
          props.set("MyResponseType", `<t:MyResponseType>Organizer</t:MyResponseType>`);
          if (invitations && invitations != "SendToNone" && (props.has("RequiredAttendees") || props.has("OptionalAttendees"))) {
            this.sent.push({ invitation: el.childText("Subject"), attendees: el.findAll("EmailAddress").map(e => e.text) });
          }
        }
        props.set("ItemClass", `<t:ItemClass>${el.name == "Contact" ? "IPM.Contact" : "IPM.Appointment"}</t:ItemClass>`);
        const item = { id: newId("I"), changeKey: "CQ" + ++this.seq, folderId: folder.id, kind: el.name, props, isRead: true, ext: {}, named };
        this.items.set(item.id, item);
        this.#record(folder.id, "create", item.id);
        return okMsg("CreateItem", `<m:Items><t:${el.name}><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:${el.name}></m:Items>`);
      }
      if (["AcceptItem", "TentativelyAcceptItem", "DeclineItem"].includes(el.name)) {
        const ref = el.child("ReferenceItemId");
        const idx = el.children.indexOf(ref);
        if (idx != el.children.length - 1 && el.elements().slice(el.elements().indexOf(ref) + 1).length) throw new SchemaError("ReferenceItemId must come last");
        const item = this.items.get(ref.attr("Id"));
        if (!item) return errMsg("CreateItem", "ErrorItemNotFound", "");
        const resp = { AcceptItem: "Accept", TentativelyAcceptItem: "Tentative", DeclineItem: "Decline" }[el.name];
        this.responses.push({ id: item.id, response: resp, send: disposition == "SendAndSaveCopy" });
        if (resp == "Decline") {
          this.items.delete(item.id);
          this.#record(item.folderId, "delete", item.id);
        } else {
          item.props.set("MyResponseType", `<t:MyResponseType>${resp}</t:MyResponseType>`);
          this.#bump(item);
        }
        return okMsg("CreateItem", "<m:Items/>");
      }
      return errMsg("CreateItem", "ErrorInvalidRequest", `mock: cannot create ${el.name}`);
    }).join("");
  }

  opUpdateItem(body) {
    const sendUpdates = body.attr("SendMeetingInvitationsOrCancellations");
    return body.child("ItemChanges").elements().map(ch => {
      const reqId = ch.child("ItemId").attr("Id");
      const item = reqId.startsWith("occ~") ? this.materialize(reqId) : this.items.get(reqId);
      if (!item) return errMsg("UpdateItem", "ErrorItemNotFound", "The specified object was not found in the store.");
      let readOnly = true;
      for (const u of ch.child("Updates").elements()) {
        const uri = u.elements()[0];
        const wrapper = u.elements()[1];
        if (wrapper) {
          if (wrapper.name != item.kind) return errMsg("UpdateItem", "ErrorObjectTypeChanged", `Tried to update ${item.kind} as ${wrapper.name}`);
          checkOrder(wrapper);
        }
        if (uri.name == "FieldURI") {
          const name = uri.attr("FieldURI").split(":").pop();
          if (u.name == "DeleteItemField") { item.props.delete(name); readOnly = false; continue; }
          const val = wrapper.child(name) || wrapper.elements()[0];
          if (name == "IsRead") { item.isRead = val.text == "true"; continue; }
          readOnly = false;
          item.props.set(val.name, serialize(val));
        } else if (uri.name == "ExtendedFieldURI") {
          readOnly = false;
          const t = normTag(uri.attr("PropertyTag"));
          if (u.name == "DeleteItemField") delete item.ext[t];
          else item.ext[t] = wrapper.find("Value").text;
        } else if (uri.name == "IndexedFieldURI") {
          readOnly = false;
          const dictName = { EmailAddress: "EmailAddresses", PhoneNumber: "PhoneNumbers", PhysicalAddress: "PhysicalAddresses", ImAddress: "ImAddresses" }[uri.attr("FieldURI").split(":")[1]];
          const key = uri.attr("FieldIndex");
          const existing = item.props.get(dictName) ? parseXml(item.props.get(dictName).replace(/<t:/g, "<").replace(/<\/t:/g, "</")) : new XmlElement(dictName);
          const entries = existing.elements("Entry").filter(e => e.attr("Key") != key);
          if (u.name != "DeleteItemField") {
            const newEntry = wrapper.find("Entry");
            const old = existing.elements("Entry").find(e => e.attr("Key") == key);
            if (old && uri.attr("FieldURI").split(":").length > 2) {
              // PhysicalAddress:Street style: merge child
              for (const c of newEntry.elements()) {
                old.children = old.children.filter(x => typeof x == "string" || x.name != c.name);
                old.children.push(c);
              }
              entries.push(old);
            } else entries.push(newEntry);
          }
          existing.children = entries;
          if (entries.length) item.props.set(dictName, serialize(existing));
          else item.props.delete(dictName);
        }
      }
      if (item.kind == "CalendarItem" && sendUpdates && sendUpdates != "SendToNone") this.sent.push({ update: item.id, subject: propText(item, "Subject") });
      if (item.masterId) {
        item.changeKey = "CQ" + ++this.seq;
        this.#bump(this.items.get(item.masterId));
        return okMsg("UpdateItem", `<m:Items><t:CalendarItem><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:CalendarItem></m:Items>`);
      }
      if (item.kind == "CalendarItem") {
        item.props.set("CalendarItemType", `<t:CalendarItemType>${item.props.has("Recurrence") ? "RecurringMaster" : "Single"}</t:CalendarItemType>`);
        if (!item.props.has("Recurrence")) { item.exceptions = []; item.deletedOcc = []; }
      }
      this.#bump(item, readOnly ? "readflag" : "update");
      return okMsg("UpdateItem", `<m:Items><t:${item.kind}><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:${item.kind}></m:Items>`);
    }).join("");
  }

  #moveCopy(body, op, copy) {
    const to = this.#resolveFolder(body.child("ToFolderId"));
    return body.child("ItemIds").elements().map(ref => {
      const item = this.items.get(ref.attr("Id"));
      if (!item) return errMsg(op, "ErrorItemNotFound", "");
      const clone = { ...item, props: new Map(item.props), ext: { ...item.ext }, id: newId("I"), changeKey: "CQ" + ++this.seq, folderId: to.id };
      if (!copy) {
        this.items.delete(item.id);
        this.#record(item.folderId, "delete", item.id);
      }
      this.items.set(clone.id, clone);
      this.#record(to.id, "create", clone.id);
      return okMsg(op, `<m:Items><t:${clone.kind}><t:ItemId Id="${clone.id}" ChangeKey="${clone.changeKey}"/></t:${clone.kind}></m:Items>`);
    }).join("");
  }

  opMoveItem(body) { return this.#moveCopy(body, "MoveItem", false); }
  opCopyItem(body) { return this.#moveCopy(body, "CopyItem", true); }

  opDeleteItem(body) {
    if (!body.attr("SendMeetingCancellations")) throw new SchemaError("SendMeetingCancellations required");
    return body.child("ItemIds").elements().map(ref => {
      const rid = ref.attr("Id");
      if (rid.startsWith("occ~") || this.items.get(rid)?.masterId) {
        const [masterId, t] = rid.startsWith("occ~") ? [rid.split("~")[1], Number(rid.split("~")[2])] : [this.items.get(rid).masterId, this.items.get(rid).originalStart];
        const master = this.items.get(masterId);
        (master.deletedOcc ||= []).push(t);
        master.exceptions = (master.exceptions || []).filter(e => e.originalStart != t);
        if (!rid.startsWith("occ~")) this.items.delete(rid);
        if (body.attr("SendMeetingCancellations") != "SendToNone") this.sent.push({ cancelOccurrence: t });
        this.#bump(master);
        return okMsg("DeleteItem", "");
      }
      const item = this.items.get(rid);
      if (!item) return errMsg("DeleteItem", "ErrorItemNotFound", "");
      this.items.delete(item.id);
      this.#record(item.folderId, "delete", item.id);
      if (item.kind == "CalendarItem" && body.attr("SendMeetingCancellations") != "SendToNone") this.sent.push({ cancel: item.id });
      if (body.attr("DeleteType") == "MoveToDeletedItems") {
        const d = this.folder("deleteditems");
        const clone = { ...item, id: newId("I"), folderId: d.id };
        this.items.set(clone.id, clone);
        this.#record(d.id, "create", clone.id);
      }
      return okMsg("DeleteItem", "");
    }).join("");
  }

  opFindItem(body) {
    const f = this.#resolveFolder(body.child("ParentFolderIds"));
    const shape = body.child("ItemShape");
    const cv = body.child("CalendarView");
    if (cv) {
      const from = Date.parse(cv.attr("StartDate"));
      const to = Date.parse(cv.attr("EndDate"));
      const out = [];
      for (const item of [...this.items.values()].filter(i => i.folderId == f.id && i.kind == "CalendarItem" && !i.masterId)) {
        for (const occ of this.expand(item, from, to)) out.push(occ);
      }
      return okMsg("FindItem", `<m:RootFolder TotalItemsInView="${out.length}" IncludesLastItemInRange="true"><t:Items>${out.map(o => this.#itemXml(o, shape)).join("")}</t:Items></m:RootFolder>`);
    }
    const restriction = body.child("Restriction")?.elements()[0];
    let items = [...this.items.values()].filter(i => i.folderId == f.id);
    if (restriction) items = items.filter(i => this.#matches(i, restriction));
    return okMsg("FindItem", `<m:RootFolder TotalItemsInView="${items.length}" IncludesLastItemInRange="true"><t:Items>${items.map(i => this.#itemXml(i, shape)).join("")}</t:Items></m:RootFolder>`);
  }

  #matches(item, r) {
    switch (r.name) {
      case "And": return r.elements().every(c => this.#matches(item, c));
      case "Or": return r.elements().some(c => this.#matches(item, c));
      case "Not": return !this.#matches(item, r.elements()[0]);
      case "Contains":
      case "IsEqualTo": {
        const uri = r.child("FieldURI").attr("FieldURI");
        const needle = (r.child("Constant") || r.find("Constant")).attr("Value").toLowerCase();
        const text = this.#fieldText(item, uri).toLowerCase();
        return r.name == "Contains" ? text.includes(needle) : text == needle;
      }
      default: throw new Error(`mock restriction ${r.name}`);
    }
  }

  #fieldText(item, uri) {
    const name = uri.split(":").pop();
    if (name == "Body" || name == "TextBody") return item.mime ? utf8Decode(item.mime) : "";
    const xml = item.props.get(name) || "";
    return xml.replace(/<[^>]+>/g, " ");
  }

  /** Occurrences of a calendar item overlapping [from, to) (Daily/Weekly only, UTC-based). */
  expand(item, from, to) {
    const start = Date.parse(propText(item, "Start"));
    const end = Date.parse(propText(item, "End"));
    const dur = end - start;
    const recXml = item.props.get("Recurrence");
    if (!recXml) {
      return start < to && end > from ? [item] : [];
    }
    const rec = parseXml(recXml.replace(/<(\/?)t:/g, "<$1"));
    const [pattern, range] = rec.elements();
    const interval = parseInt(pattern.childText("Interval") || "1", 10);
    const count = range.name == "NumberedRecurrence" ? parseInt(range.childText("NumberOfOccurrences"), 10) : Infinity;
    const until = range.name == "EndDateRecurrence" ? Date.parse(range.childText("EndDate") + "T23:59:59Z") : Infinity;
    const days = pattern.name == "WeeklyRecurrence" ? pattern.childText("DaysOfWeek").split(" ").map(d => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(d)) : null;
    const out = [];
    let n = 0;
    for (let t = start, i = 0; i < 2000 && n < count && t <= until; i++, t += 86400000) {
      const dayIndex = Math.floor((t - start) / 86400000);
      let hit;
      if (pattern.name == "DailyRecurrence") hit = dayIndex % interval == 0;
      else if (days) hit = days.includes(new Date(t).getUTCDay()) && Math.floor(dayIndex / 7) % interval == 0;
      else throw new Error("mock: unsupported recurrence " + pattern.name);
      if (!hit) continue;
      n++;
      if ((item.deletedOcc || []).includes(t)) continue;
      const ex = (item.exceptions || []).find(e => e.originalStart == t);
      if (ex) {
        const exItem = this.items.get(ex.id);
        const s2 = Date.parse(propText(exItem, "Start")), e2 = Date.parse(propText(exItem, "End"));
        if (s2 < to && e2 > from) out.push(exItem);
        continue;
      }
      if (t < to && t + dur > from) out.push(this.occurrence(item, t));
    }
    return out;
  }

  occurrence(master, originalStart) {
    const dur = Date.parse(propText(master, "End")) - Date.parse(propText(master, "Start"));
    const props = new Map([...master.props].filter(([k]) => !["Recurrence", "CalendarItemType"].includes(k)));
    props.set("Start", `<t:Start>${iso(originalStart)}</t:Start>`);
    props.set("End", `<t:End>${iso(originalStart + dur)}</t:End>`);
    props.set("CalendarItemType", "<t:CalendarItemType>Occurrence</t:CalendarItemType>");
    return { id: `occ~${master.id}~${originalStart}`, changeKey: master.changeKey, folderId: master.folderId, kind: "CalendarItem", props, ext: {}, isRead: true, masterId: master.id, originalStart };
  }

  /** Turn an occurrence id into a stored exception item (Exchange does this on first modification). */
  materialize(id) {
    const [, masterId, t] = id.split("~");
    const master = this.items.get(masterId);
    if (!master) return null;
    const occ = this.occurrence(master, Number(t));
    occ.id = newId("X");
    occ.props.set("CalendarItemType", "<t:CalendarItemType>Exception</t:CalendarItemType>");
    this.items.set(occ.id, occ);
    (master.exceptions ||= []).push({ id: occ.id, originalStart: Number(t) });
    return occ;
  }

  opResolveNames(body) {
    const q = body.childText("UnresolvedEntry").toLowerCase();
    const hits = this.directory.filter(d => d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q));
    if (!hits.length) return errMsg("ResolveNames", "ErrorNameResolutionNoResults", "No results were found.");
    const cls = hits.length > 1 ? "Warning" : "Success";
    const code = hits.length > 1 ? "ErrorNameResolutionMultipleResults" : "NoError";
    return `<m:ResolveNamesResponseMessage ResponseClass="${cls}"><m:ResponseCode>${code}</m:ResponseCode><m:ResolutionSet TotalItemsInView="${hits.length}" IncludesLastItemInRange="true">${hits.map(h => `<t:Resolution><t:Mailbox><t:Name>${xmlEscape(h.name)}</t:Name><t:EmailAddress>${h.email}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>Mailbox</t:MailboxType></t:Mailbox><t:Contact><t:DisplayName>${xmlEscape(h.name)}</t:DisplayName><t:GivenName>${xmlEscape(h.given || "")}</t:GivenName><t:Surname>${xmlEscape(h.surname || "")}</t:Surname><t:Department>${xmlEscape(h.department || "")}</t:Department><t:PhoneNumbers><t:Entry Key="BusinessPhone">${h.phone || ""}</t:Entry></t:PhoneNumbers></t:Contact></t:Resolution>`).join("")}</m:ResolutionSet></m:ResolveNamesResponseMessage>`;
  }
}

function propText(item, name) {
  const xml = item?.props.get(name);
  return xml ? xml.replace(/<[^>]+>/g, "") : "";
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normTag(t) {
  const n = t.startsWith("0x") || t.startsWith("0X") ? parseInt(t, 16) : parseInt(t, 10);
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

function okMsg(op, inner) {
  return `<m:${op}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${inner}</m:${op}ResponseMessage>`;
}

function errMsg(op, code, text) {
  return `<m:${op}ResponseMessage ResponseClass="Error"><m:MessageText>${xmlEscape(text)}</m:MessageText><m:ResponseCode>${code}</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey></m:${op}ResponseMessage>`;
}

function fault(code, message) {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode xmlns:a="http://schemas.microsoft.com/exchange/services/2006/types">a:${code}</faultcode><faultstring xml:lang="en-US">${xmlEscape(message)}</faultstring><detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">${code}</e:ResponseCode><e:Message xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">${xmlEscape(message)}</e:Message></detail></s:Fault></s:Body></s:Envelope>`;
}

/** Transport for tests: fetch + Basic auth (the Gecko transport does NTLM/Negotiate). */
export function basicTransport(username, password) {
  return {
    async request({ method, url, headers, body, noRedirect }) {
      const res = await fetch(url, {
        method,
        headers: { ...headers, Authorization: "Basic " + btoa(`${username}:${password}`) },
        body,
        redirect: noRedirect ? "manual" : "follow",
      });
      const h = {};
      res.headers.forEach((v, k) => (h[k] = v));
      return { status: res.status, headers: h, body: await res.text() };
    },
  };
}

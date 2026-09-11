/* EWS Bridge — EWS item/folder XML <-> JS object helpers. */

import { xmlEscape, tag, textTag } from "../xml.mjs";

// MAPI properties used via ExtendedFieldURI.
export const PROP = {
  MESSAGE_FLAGS: { tag: "0x0E07", type: "Integer" }, // 1 = read, 8 = unsent (draft)
  LAST_VERB_EXECUTED: { tag: "0x1081", type: "Integer" }, // 102 reply, 103 reply-all, 104 forward
  ICON_INDEX: { tag: "0x1080", type: "Integer" }, // 261 replied, 262 forwarded
  FLAG_STATUS: { tag: "0x1090", type: "Integer" }, // 1 complete, 2 flagged
  INTERNET_MESSAGE_SIZE: { tag: "0x0E08", type: "Integer" }, // PR_MESSAGE_SIZE
};

export const MSGFLAG_READ = 1;
export const MSGFLAG_UNSENT = 8;
export const VERB_REPLY = 102;
export const VERB_REPLY_ALL = 103;
export const VERB_FORWARD = 104;

export function extFieldURI(p) {
  return `<t:ExtendedFieldURI PropertyTag="${p.tag}" PropertyType="${p.type}"/>`;
}

export function extProperty(p, value) {
  return `<t:ExtendedProperty>${extFieldURI(p)}<t:Value>${xmlEscape(value)}</t:Value></t:ExtendedProperty>`;
}

/** XML for a folder reference: "@inbox" = distinguished, anything else an Id. */
export function folderIdXml(ref, mailbox = null) {
  if (typeof ref == "object" && ref) {
    return `<t:FolderId Id="${xmlEscape(ref.id)}"${ref.changeKey ? ` ChangeKey="${xmlEscape(ref.changeKey)}"` : ""}/>`;
  }
  if (ref.startsWith("@")) {
    const mb = mailbox ? `<t:Mailbox><t:EmailAddress>${xmlEscape(mailbox)}</t:EmailAddress></t:Mailbox>` : "";
    return `<t:DistinguishedFolderId Id="${xmlEscape(ref.slice(1))}">${mb}</t:DistinguishedFolderId>`;
  }
  return `<t:FolderId Id="${xmlEscape(ref)}"/>`;
}

/** XML for an item reference: string id, or {id, changeKey}. */
export function itemIdXml(ref, elementName = "t:ItemId") {
  if (typeof ref == "string") {
    return `<${elementName} Id="${xmlEscape(ref)}"/>`;
  }
  if (ref.occurrenceOf) {
    return `<t:OccurrenceItemId RecurringMasterId="${xmlEscape(ref.occurrenceOf)}" InstanceIndex="${ref.instanceIndex}"/>`;
  }
  return `<${elementName} Id="${xmlEscape(ref.id)}"${ref.changeKey ? ` ChangeKey="${xmlEscape(ref.changeKey)}"` : ""}/>`;
}

export function fieldURI(uri) {
  return `<t:FieldURI FieldURI="${uri}"/>`;
}

/** Parse <t:Mailbox> (or anything with Name/EmailAddress children). */
export function parseMailbox(el) {
  if (!el) {
    return null;
  }
  const mb = el.name == "Mailbox" ? el : el.child("Mailbox") || el;
  return {
    name: mb.childText("Name", ""),
    email: mb.childText("EmailAddress", ""),
    routingType: mb.childText("RoutingType", "SMTP"),
    mailboxType: mb.childText("MailboxType", null),
  };
}

export function parseMailboxList(el) {
  if (!el) {
    return [];
  }
  return el.elements("Mailbox").map(parseMailbox);
}

function bool(v) {
  return v === null ? null : v == "true";
}

function int(v) {
  if (v === null || v === undefined) {
    return null;
  }
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse ExtendedProperty children into { "0x1090": "2", "name:Foo": ... }. */
export function parseExtended(el) {
  const out = {};
  for (const ep of el.elements("ExtendedProperty")) {
    const uri = ep.child("ExtendedFieldURI");
    if (!uri) {
      continue;
    }
    let key = uri.attr("PropertyTag");
    if (key) {
      // normalise "4240" / "0x1090" forms
      const n = key.startsWith("0x") || key.startsWith("0X") ? parseInt(key, 16) : parseInt(key, 10);
      key = "0x" + n.toString(16).toUpperCase().padStart(4, "0");
    } else {
      key = `${uri.attr("DistinguishedPropertySetId") || uri.attr("PropertySetId")}:${uri.attr("PropertyName") ?? uri.attr("PropertyId")}`;
    }
    const values = ep.child("Values");
    out[key] = values ? values.elements("Value").map(v => v.text) : ep.childText("Value");
  }
  return out;
}

/** Parse the common subset of a mail-ish item element. */
export function parseItem(el) {
  const idEl = el.child("ItemId");
  const flag = el.child("Flag");
  const item = {
    kind: el.name, // Message, MeetingRequest, CalendarItem, Contact, Item, ...
    id: idEl?.attr("Id") ?? null,
    changeKey: idEl?.attr("ChangeKey") ?? null,
    parentFolderId: el.child("ParentFolderId")?.attr("Id") ?? null,
    itemClass: el.childText("ItemClass"),
    subject: el.childText("Subject"),
    size: int(el.childText("Size")),
    dateTimeReceived: el.childText("DateTimeReceived"),
    dateTimeSent: el.childText("DateTimeSent"),
    dateTimeCreated: el.childText("DateTimeCreated"),
    lastModifiedTime: el.childText("LastModifiedTime"),
    importance: el.childText("Importance"),
    sensitivity: el.childText("Sensitivity"),
    hasAttachments: bool(el.childText("HasAttachments")),
    isRead: bool(el.childText("IsRead")),
    isDraft: bool(el.childText("IsDraft")),
    categories: el.child("Categories") ? el.child("Categories").elements("String").map(s => s.text) : null,
    flagStatus: flag ? flag.childText("FlagStatus") : null,
    internetMessageId: el.childText("InternetMessageId"),
    inReplyTo: el.childText("InReplyTo"),
    references: el.childText("References"),
    from: parseMailbox(el.child("From")),
    sender: parseMailbox(el.child("Sender")),
    replyTo: parseMailboxList(el.child("ReplyTo")),
    to: parseMailboxList(el.child("ToRecipients")),
    cc: parseMailboxList(el.child("CcRecipients")),
    bcc: parseMailboxList(el.child("BccRecipients")),
    ext: parseExtended(el),
    mime: el.childText("MimeContent"),
    headers: el.child("InternetMessageHeaders")
      ? el.child("InternetMessageHeaders").elements("InternetMessageHeader").map(h => [h.attr("HeaderName"), h.text])
      : null,
    element: el,
  };
  return item;
}

export function parseFolder(el) {
  const idEl = el.child("FolderId");
  return {
    kind: el.name, // Folder, CalendarFolder, ContactsFolder, SearchFolder, TasksFolder
    id: idEl?.attr("Id") ?? null,
    changeKey: idEl?.attr("ChangeKey") ?? null,
    parentId: el.child("ParentFolderId")?.attr("Id") ?? null,
    folderClass: el.childText("FolderClass"),
    displayName: el.childText("DisplayName"),
    totalCount: int(el.childText("TotalCount")),
    childFolderCount: int(el.childText("ChildFolderCount")),
    unreadCount: int(el.childText("UnreadCount")),
    distinguishedId: null,
  };
}

/** <t:Mailbox> XML. */
export function mailboxXml({ name, email }, elementName = "t:Mailbox") {
  return tag(elementName, [textTag("t:Name", name || null), textTag("t:EmailAddress", email)]);
}

/** Attendee list XML: <t:RequiredAttendees><t:Attendee><t:Mailbox>... */
export function attendeesXml(elementName, list) {
  if (!list || !list.length) {
    return "";
  }
  return tag(
    elementName,
    list.map(a => tag("t:Attendee", mailboxXml(a)))
  );
}

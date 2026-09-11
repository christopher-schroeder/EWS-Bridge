/* EWS Bridge — build an RFC 5322 header block from EWS item properties.
 * Used for Thunderbird's header-only fetches so initial sync does not have to
 * download every full message.
 */

import { encodeHeaderValue, formatAddress, formatRfc2822Date } from "../mime.mjs";
import { utf8Encode, isAscii } from "../util.mjs";

// Headers we generate from structured properties (never copied verbatim).
const SYNTHESIZED = new Set([
  "date", "from", "sender", "reply-to", "to", "cc", "bcc", "subject", "message-id",
  "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding",
  "x-priority", "importance", "priority",
]);

function mailboxToHeader(mb) {
  if (!mb) {
    return null;
  }
  let email = mb.email || "";
  if (!email.includes("@")) {
    // Exchange-internal (EX) address without SMTP form.
    email = "unknown@exchange.invalid";
  }
  return formatAddress({ name: mb.name, email });
}

function list(mbs) {
  return (mbs || []).map(mailboxToHeader).filter(Boolean).join(", ");
}

/** Fold a header line at ~78 columns on whitespace. */
function fold(name, value) {
  const line = `${name}: ${value}`;
  if (line.length <= 78) {
    return line;
  }
  const words = line.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > 76) {
      lines.push(cur);
      cur = " " + w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  lines.push(cur);
  return lines.join("\r\n");
}

/**
 * @param {object} item  parsed EWS item with MAIL_HEADER_PROPS
 * @returns {string} binary string header block ending in an empty line
 */
export function buildHeaderBlock(item) {
  const out = [];
  const add = (name, value) => {
    if (value !== null && value !== undefined && value !== "") {
      out.push(fold(name, value));
    }
  };
  const original = new Map();
  for (const [name, value] of item.headers || []) {
    if (!name) {
      continue;
    }
    const k = name.toLowerCase();
    if (!original.has(k)) {
      original.set(k, []);
    }
    original.get(k).push(value);
  }

  const date = item.dateTimeSent || item.dateTimeReceived;
  add("Date", date ? formatRfc2822Date(date) : null);
  add("From", mailboxToHeader(item.from));
  if (item.sender && item.from && item.sender.email && item.sender.email.toLowerCase() != (item.from.email || "").toLowerCase()) {
    add("Sender", mailboxToHeader(item.sender));
  }
  add("Reply-To", list(item.replyTo));
  add("To", list(item.to));
  add("Cc", list(item.cc));
  add("Bcc", list(item.bcc));
  add("Subject", encodeHeaderValue(item.subject || ""));
  add("Message-ID", item.internetMessageId);
  add("In-Reply-To", item.inReplyTo);
  add("References", item.references);
  if (item.importance == "High") {
    add("X-Priority", "1 (Highest)");
    add("Importance", "high");
  } else if (item.importance == "Low") {
    add("X-Priority", "5 (Lowest)");
    add("Importance", "low");
  }
  add("MIME-Version", "1.0");
  const ct = original.get("content-type")?.[0];
  if (ct && isAscii(ct)) {
    add("Content-Type", ct);
  } else if (item.hasAttachments) {
    add("Content-Type", 'multipart/mixed; boundary="----=_exchange_bridge"');
  } else {
    add("Content-Type", "text/plain; charset=UTF-8");
  }
  for (const [k, values] of original) {
    if (SYNTHESIZED.has(k)) {
      continue;
    }
    const name = (item.headers.find(([n]) => n.toLowerCase() == k) || [k])[0];
    for (const v of values) {
      if (v === null || v === undefined) {
        continue;
      }
      add(name, isAscii(v) ? v.replace(/[\r\n]+/g, " ") : encodeHeaderValue(v));
    }
  }
  return utf8Encode(out.join("\r\n")) + "\r\n\r\n";
}

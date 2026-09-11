/* EWS Bridge — Exchange contacts <-> vCard (3.0 out; 3.0/4.0 in). */

import { Component, parseComponents, serialize, escapeText, unescapeText, splitList } from "../cal/ical.mjs";
import { xmlEscape, textTag } from "../xml.mjs";

export const UID_PROP = { set: "PublicStrings", name: "ExchangeBridgeVCardUid", type: "String" };

export function uidFieldURI() {
  return `<t:ExtendedFieldURI DistinguishedPropertySetId="${UID_PROP.set}" PropertyName="${UID_PROP.name}" PropertyType="${UID_PROP.type}"/>`;
}

const PHONE_KEYS = ["BusinessPhone", "BusinessPhone2", "HomePhone", "HomePhone2", "MobilePhone", "BusinessFax", "HomeFax", "OtherFax", "Pager", "OtherTelephone", "CompanyMainPhone", "AssistantPhone", "CarPhone"];
const ADDRESS_KEYS = ["Business", "Home", "Other"];
const ADDRESS_PARTS = ["Street", "City", "State", "CountryOrRegion", "PostalCode"];

function dateOnly(s) {
  if (!s) {
    return null;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    return null;
  }
  // Exchange stores birthdays as a moment in the owner's zone; noon UTC stays on the right day.
  const d = new Date(t + 12 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Parse an EWS <t:Contact> element into a model. */
export function ewsToContact(el) {
  const idEl = el.child("ItemId");
  const dict = (name, key) => el.child(name)?.elements("Entry").find(e => e.attr("Key") == key) || null;
  const model = {
    id: idEl?.attr("Id") ?? null,
    changeKey: idEl?.attr("ChangeKey") ?? null,
    uid: null,
    displayName: el.childText("DisplayName") || el.childText("FileAs") || "",
    given: el.childText("GivenName"),
    middle: el.childText("MiddleName"),
    surname: el.childText("Surname"),
    suffix: el.childText("Generation"),
    nickname: el.childText("Nickname"),
    company: el.childText("CompanyName"),
    department: el.childText("Department"),
    jobTitle: el.childText("JobTitle"),
    office: el.childText("OfficeLocation"),
    url: el.childText("BusinessHomePage"),
    birthday: dateOnly(el.childText("Birthday")),
    anniversary: dateOnly(el.childText("WeddingAnniversary")),
    notes: el.child("Body") ? el.child("Body").text : null,
    categories: el.child("Categories") ? el.child("Categories").elements("String").map(s => s.text) : [],
    emails: [1, 2, 3].map(i => dict("EmailAddresses", `EmailAddress${i}`)?.text?.replace(/^smtp:/i, "") || null),
    phones: Object.fromEntries(PHONE_KEYS.map(k => [k, dict("PhoneNumbers", k)?.text || null])),
    addresses: Object.fromEntries(
      ADDRESS_KEYS.map(k => {
        const e = dict("PhysicalAddresses", k);
        return [k, e ? Object.fromEntries(ADDRESS_PARTS.map(p => [p, e.childText(p)])) : null];
      })
    ),
  };
  for (const ep of el.elements("ExtendedProperty")) {
    if (ep.child("ExtendedFieldURI")?.attr("PropertyName") == UID_PROP.name) {
      model.uid = ep.childText("Value");
    }
  }
  return model;
}

const TEL_TYPES = {
  BusinessPhone: "WORK,VOICE",
  BusinessPhone2: "WORK,VOICE",
  HomePhone: "HOME,VOICE",
  HomePhone2: "HOME,VOICE",
  MobilePhone: "CELL",
  BusinessFax: "WORK,FAX",
  HomeFax: "HOME,FAX",
  OtherFax: "FAX",
  Pager: "PAGER",
  OtherTelephone: "VOICE",
  CompanyMainPhone: "WORK,VOICE",
  AssistantPhone: "VOICE",
  CarPhone: "CAR",
};

/** Contact model -> vCard 3.0 text. */
export function contactToVCard(m) {
  const v = new Component("VCARD");
  v.add("VERSION", "3.0");
  v.add("PRODID", "-//EWS Bridge//EN");
  v.add("UID", m.uid);
  v.add("FN", escapeText(m.displayName || [m.given, m.surname].filter(Boolean).join(" ") || m.emails.find(Boolean) || ""));
  v.add("N", [m.surname, m.given, m.middle, "", m.suffix].map(x => escapeText(x || "")).join(";"));
  if (m.nickname) v.add("NICKNAME", escapeText(m.nickname));
  if (m.company || m.department) v.add("ORG", [m.company, m.department].map(x => escapeText(x || "")).join(";"));
  if (m.jobTitle) v.add("TITLE", escapeText(m.jobTitle));
  m.emails.forEach((e, i) => {
    if (e) {
      v.add("EMAIL", e, i == 0 ? { TYPE: ["INTERNET", "PREF"] } : { TYPE: "INTERNET" });
    }
  });
  for (const k of PHONE_KEYS) {
    if (m.phones[k]) {
      v.add("TEL", m.phones[k], { TYPE: TEL_TYPES[k].split(",") });
    }
  }
  for (const k of ADDRESS_KEYS) {
    const a = m.addresses[k];
    if (a && ADDRESS_PARTS.some(p => a[p])) {
      v.add("ADR", ["", "", a.Street, a.City, a.State, a.PostalCode, a.CountryOrRegion].map(x => escapeText(x || "")).join(";"), { TYPE: { Business: "WORK", Home: "HOME", Other: "OTHER" }[k] });
    }
  }
  if (m.url) v.add("URL", m.url);
  if (m.birthday) v.add("BDAY", m.birthday, { VALUE: "DATE" });
  if (m.anniversary) v.add("X-ANNIVERSARY", m.anniversary);
  if (m.office) v.add("X-OFFICE-LOCATION", escapeText(m.office));
  if (m.notes) v.add("NOTE", escapeText(m.notes.replace(/\r\n/g, "\n").replace(/\s+$/, "")));
  if (m.categories.length) v.add("CATEGORIES", m.categories.map(escapeText).join(","));
  return serialize(v);
}

function types(p) {
  const t = p.params.TYPE;
  const list = Array.isArray(t) ? t : t ? String(t).split(",") : [];
  return list.map(x => x.toUpperCase());
}

function normDate(v) {
  if (!v) return null;
  const s = v.replace(/^--/, "1604-"); // year-less dates (vCard 4) — Exchange needs a year
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** vCard text -> contact model. */
export function vcardToContact(text) {
  const card = parseComponents(text).find(c => c.name == "VCARD");
  if (!card) {
    throw new Error("Not a vCard");
  }
  const val = n => (card.get(n) ? unescapeText(card.value(n)) : null);
  const n = card.get("N") ? splitStructured(card.value("N")) : [];
  const org = card.get("ORG") ? splitStructured(card.value("ORG")) : [];
  const m = {
    uid: card.value("UID"),
    displayName: val("FN") || "",
    surname: n[0] || null,
    given: n[1] || null,
    middle: n[2] || null,
    suffix: n[4] || null,
    nickname: val("NICKNAME"),
    company: org[0] || null,
    department: org[1] || null,
    jobTitle: val("TITLE"),
    office: val("X-OFFICE-LOCATION"),
    url: card.value("URL"),
    birthday: normDate(card.value("BDAY")),
    anniversary: normDate(card.value("ANNIVERSARY") || card.value("X-ANNIVERSARY")),
    notes: val("NOTE"),
    categories: card.getAll("CATEGORIES").flatMap(p => splitList(p.value).map(unescapeText)).filter(Boolean),
    emails: [null, null, null],
    phones: Object.fromEntries(PHONE_KEYS.map(k => [k, null])),
    addresses: { Business: null, Home: null, Other: null },
  };
  // Preferred e-mail first, Exchange keeps three.
  const emails = card.getAll("EMAIL").map(p => ({ v: p.value.replace(/^mailto:/i, ""), pref: types(p).includes("PREF") || p.params.PREF == "1" }));
  emails.sort((a, b) => b.pref - a.pref);
  emails.slice(0, 3).forEach((e, i) => (m.emails[i] = e.v));
  for (const p of card.getAll("TEL")) {
    const t = types(p);
    const value = p.value.replace(/^tel:/i, "");
    const fax = t.includes("FAX");
    const order = t.includes("CELL")
      ? ["MobilePhone"]
      : t.includes("PAGER")
        ? ["Pager"]
        : t.includes("CAR")
          ? ["CarPhone"]
          : fax
            ? t.includes("WORK") ? ["BusinessFax"] : t.includes("HOME") ? ["HomeFax"] : ["OtherFax"]
            : t.includes("WORK")
              ? ["BusinessPhone", "BusinessPhone2", "CompanyMainPhone"]
              : t.includes("HOME")
                ? ["HomePhone", "HomePhone2"]
                : ["OtherTelephone", "BusinessPhone", "HomePhone"];
    const slot = order.find(k => !m.phones[k]);
    if (slot) {
      m.phones[slot] = value;
    }
  }
  for (const p of card.getAll("ADR")) {
    const t = types(p);
    const key = t.includes("WORK") ? "Business" : t.includes("HOME") ? "Home" : "Other";
    const parts = splitStructured(p.value);
    const addr = { Street: [parts[1], parts[2]].filter(Boolean).join("\n") || null, City: parts[3] || null, State: parts[4] || null, PostalCode: parts[5] || null, CountryOrRegion: parts[6] || null };
    if (!m.addresses[key]) {
      m.addresses[key] = addr;
    } else if (!m.addresses.Other) {
      m.addresses.Other = addr;
    }
  }
  return m;
}

function splitStructured(v) {
  const out = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] == "\\" && i + 1 < v.length) {
      cur += v[i] + v[i + 1];
      i++;
    } else if (v[i] == ";") {
      out.push(unescapeText(cur));
      cur = "";
    } else {
      cur += v[i];
    }
  }
  out.push(unescapeText(cur));
  return out;
}

// ---------------------------------------------------------------------------
// model -> EWS

const SIMPLE = [
  // [model key, FieldURI, element]
  ["displayName", "contacts:DisplayName", "DisplayName"],
  ["given", "contacts:GivenName", "GivenName"],
  ["middle", "contacts:MiddleName", "MiddleName"],
  ["nickname", "contacts:Nickname", "Nickname"],
  ["company", "contacts:CompanyName", "CompanyName"],
  ["url", "contacts:BusinessHomePage", "BusinessHomePage"],
  ["department", "contacts:Department", "Department"],
  ["suffix", "contacts:Generation", "Generation"],
  ["jobTitle", "contacts:JobTitle", "JobTitle"],
  ["office", "contacts:OfficeLocation", "OfficeLocation"],
  ["surname", "contacts:Surname", "Surname"],
];

const bdayValue = d => (d ? `${d}T12:00:00Z` : null);

export function contactToCreateXml(m) {
  const addrXml = () => {
    const entries = ADDRESS_KEYS.filter(k => m.addresses[k] && ADDRESS_PARTS.some(p => m.addresses[k][p]))
      .map(k => `<t:Entry Key="${k}">${ADDRESS_PARTS.map(p => textTag(`t:${p}`, m.addresses[k][p] || null)).join("")}</t:Entry>`);
    return entries.length ? `<t:PhysicalAddresses>${entries.join("")}</t:PhysicalAddresses>` : "";
  };
  const emails = m.emails.map((e, i) => (e ? `<t:Entry Key="EmailAddress${i + 1}">${xmlEscape(e)}</t:Entry>` : "")).join("");
  const phones = PHONE_KEYS.filter(k => m.phones[k]).map(k => `<t:Entry Key="${k}">${xmlEscape(m.phones[k])}</t:Entry>`).join("");
  const fileAs = m.surname && m.given ? `${m.surname}, ${m.given}` : m.displayName;
  return (
    `<t:Contact>` +
    (m.notes ? textTag("t:Body", m.notes, { BodyType: "Text" }) : "") +
    (m.categories.length ? `<t:Categories>${m.categories.map(c => textTag("t:String", c)).join("")}</t:Categories>` : "") +
    (m.uid ? `<t:ExtendedProperty>${uidFieldURI()}<t:Value>${xmlEscape(m.uid)}</t:Value></t:ExtendedProperty>` : "") +
    textTag("t:FileAs", fileAs || null) +
    textTag("t:DisplayName", m.displayName || null) +
    textTag("t:GivenName", m.given || null) +
    textTag("t:MiddleName", m.middle || null) +
    textTag("t:Nickname", m.nickname || null) +
    textTag("t:CompanyName", m.company || null) +
    (emails ? `<t:EmailAddresses>${emails}</t:EmailAddresses>` : "") +
    addrXml() +
    (phones ? `<t:PhoneNumbers>${phones}</t:PhoneNumbers>` : "") +
    textTag("t:Birthday", bdayValue(m.birthday)) +
    textTag("t:BusinessHomePage", m.url || null) +
    textTag("t:Department", m.department || null) +
    textTag("t:Generation", m.suffix || null) +
    textTag("t:JobTitle", m.jobTitle || null) +
    textTag("t:OfficeLocation", m.office || null) +
    textTag("t:Surname", m.surname || null) +
    textTag("t:WeddingAnniversary", bdayValue(m.anniversary)) +
    `</t:Contact>`
  );
}

/** UpdateItem operations turning contact `a` into `b`. */
export function diffContacts(a, b) {
  const set = [];
  const del = [];
  const wrap = inner => `<t:Contact>${inner}</t:Contact>`;
  for (const [key, uri, elName] of SIMPLE) {
    if ((a[key] || null) != (b[key] || null)) {
      if (b[key]) set.push(`<t:FieldURI FieldURI="${uri}"/>${wrap(textTag(`t:${elName}`, b[key]))}`);
      else del.push(`<t:FieldURI FieldURI="${uri}"/>`);
    }
  }
  for (const [key, uri, elName] of [["birthday", "contacts:Birthday", "Birthday"], ["anniversary", "contacts:WeddingAnniversary", "WeddingAnniversary"]]) {
    if ((a[key] || null) != (b[key] || null)) {
      if (b[key]) set.push(`<t:FieldURI FieldURI="${uri}"/>${wrap(textTag(`t:${elName}`, bdayValue(b[key])))}`);
      else del.push(`<t:FieldURI FieldURI="${uri}"/>`);
    }
  }
  const normNotes = s => (s || "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (normNotes(a.notes) != normNotes(b.notes)) {
    if (b.notes) set.push(`<t:FieldURI FieldURI="item:Body"/>${wrap(textTag("t:Body", b.notes, { BodyType: "Text" }))}`);
    else del.push(`<t:FieldURI FieldURI="item:Body"/>`);
  }
  if (a.categories.join("\n") != b.categories.join("\n")) {
    if (b.categories.length) set.push(`<t:FieldURI FieldURI="item:Categories"/>${wrap(`<t:Categories>${b.categories.map(c => textTag("t:String", c)).join("")}</t:Categories>`)}`);
    else del.push(`<t:FieldURI FieldURI="item:Categories"/>`);
  }
  b.emails.forEach((e, i) => {
    const key = `EmailAddress${i + 1}`;
    if ((a.emails[i] || null) != (e || null)) {
      const uri = `<t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="${key}"/>`;
      if (e) set.push(`${uri}${wrap(`<t:EmailAddresses><t:Entry Key="${key}">${xmlEscape(e)}</t:Entry></t:EmailAddresses>`)}`);
      else del.push(uri);
    }
  });
  for (const k of PHONE_KEYS) {
    if ((a.phones[k] || null) != (b.phones[k] || null)) {
      const uri = `<t:IndexedFieldURI FieldURI="contacts:PhoneNumber" FieldIndex="${k}"/>`;
      if (b.phones[k]) set.push(`${uri}${wrap(`<t:PhoneNumbers><t:Entry Key="${k}">${xmlEscape(b.phones[k])}</t:Entry></t:PhoneNumbers>`)}`);
      else del.push(uri);
    }
  }
  for (const k of ADDRESS_KEYS) {
    for (const p of ADDRESS_PARTS) {
      const before = a.addresses[k]?.[p] || null;
      const after = b.addresses[k]?.[p] || null;
      if (before != after) {
        const uri = `<t:IndexedFieldURI FieldURI="contacts:PhysicalAddress:${p}" FieldIndex="${k}"/>`;
        if (after) set.push(`${uri}${wrap(`<t:PhysicalAddresses><t:Entry Key="${k}">${textTag(`t:${p}`, after)}</t:Entry></t:PhysicalAddresses>`)}`);
        else del.push(uri);
      }
    }
  }
  return { set, del };
}

/** A GAL (ResolveNames) hit as a vCard for Thunderbird's address book provider. */
export function galEntryToVCard(hit) {
  const m = hit.contact ? ewsToContact(hit.contact) : { emails: [null, null, null], phones: {}, addresses: {}, categories: [] };
  m.uid = `gal-${hit.email.toLowerCase()}`;
  m.displayName = m.displayName || hit.name || hit.email;
  m.emails = [hit.email, ...(m.emails || []).filter(e => e && e.toLowerCase() != hit.email.toLowerCase())].slice(0, 3);
  m.phones = Object.fromEntries(PHONE_KEYS.map(k => [k, m.phones?.[k] || null]));
  m.addresses = Object.fromEntries(ADDRESS_KEYS.map(k => [k, m.addresses?.[k] || null]));
  return contactToVCard(m);
}

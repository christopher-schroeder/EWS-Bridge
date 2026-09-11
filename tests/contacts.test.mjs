import { assert, assertEquals } from "./assert.mjs";
import { parseXml } from "../core/xml.mjs";
import { ewsToContact, contactToVCard, vcardToContact, contactToCreateXml, diffContacts, galEntryToVCard } from "../core/contacts/convert.mjs";
import { ExchangeAddressBook } from "../core/contacts/addressbook.mjs";
import { DavServer } from "../core/dav/server.mjs";
import { MockExchange, basicTransport } from "./mock-ews.mjs";
import { EwsClient } from "../core/ews/client.mjs";
import { MemoryStore } from "../core/store.mjs";
import { utf8Encode } from "../core/util.mjs";

const TB_VCARD = `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:3f1c2a9e-tb\r\nFN:Dr. Jörg Müller\r\nN:Müller;Jörg;;Dr.;\r\nEMAIL;PREF=1:joerg.mueller@tu-dortmund.de\r\nEMAIL;TYPE=home:jm@example.de\r\nTEL;TYPE=work;VALUE=TEXT:+49 231 755-1234\r\nTEL;TYPE=cell;VALUE=TEXT:+49 170 1234567\r\nADR;TYPE=work:;;Otto-Hahn-Str. 12;Dortmund;NRW;44227;Germany\r\nORG:TU Dortmund;Informatik\r\nTITLE:Wissenschaftlicher Mitarbeiter\r\nBDAY;VALUE=DATE:19850317\r\nNOTE:Raum 3.14\\nSprechstunde Di\r\nEND:VCARD\r\n`;

Deno.test("contacts: vCard 4 from Thunderbird -> model -> EWS XML order", () => {
  const m = vcardToContact(TB_VCARD);
  assertEquals(m.given, "Jörg");
  assertEquals(m.surname, "Müller");
  assertEquals(m.emails, ["joerg.mueller@tu-dortmund.de", "jm@example.de", null]);
  assertEquals(m.phones.BusinessPhone, "+49 231 755-1234");
  assertEquals(m.phones.MobilePhone, "+49 170 1234567");
  assertEquals(m.addresses.Business.City, "Dortmund");
  assertEquals(m.company, "TU Dortmund");
  assertEquals(m.department, "Informatik");
  assertEquals(m.birthday, "1985-03-17");
  assertEquals(m.notes, "Raum 3.14\nSprechstunde Di");
  const xml = contactToCreateXml(m).replace("<t:Contact>", '<t:Contact xmlns:t="t">');
  const names = parseXml(xml).elements().map(e => e.name);
  assertEquals(names, ["Body", "ExtendedProperty", "FileAs", "DisplayName", "GivenName", "CompanyName", "EmailAddresses", "PhysicalAddresses", "PhoneNumbers", "Birthday", "Department", "JobTitle", "Surname"]);
});

Deno.test("contacts: EWS -> vCard 3 -> model roundtrip is stable", () => {
  const el = parseXml(`<t:Contact xmlns:t="t"><t:ItemId Id="C1" ChangeKey="K"/><t:Body BodyType="Text">note</t:Body><t:DisplayName>Anna Schmidt</t:DisplayName><t:GivenName>Anna</t:GivenName><t:Surname>Schmidt</t:Surname><t:EmailAddresses><t:Entry Key="EmailAddress1">SMTP:anna@x.de</t:Entry></t:EmailAddresses><t:PhoneNumbers><t:Entry Key="BusinessPhone">123</t:Entry><t:Entry Key="HomeFax">456</t:Entry></t:PhoneNumbers><t:PhysicalAddresses><t:Entry Key="Home"><t:Street>Weg 1</t:Street><t:City>Bochum</t:City></t:Entry></t:PhysicalAddresses><t:Birthday>1990-01-01T11:00:00Z</t:Birthday></t:Contact>`);
  const m = ewsToContact(el);
  m.uid = "u1";
  const v = contactToVCard(m);
  assert(v.includes("EMAIL;TYPE=INTERNET,PREF:anna@x.de"), v);
  assert(v.includes("TEL;TYPE=HOME,FAX:456"), v);
  assert(v.includes("BDAY;VALUE=DATE:1990-01-01"), v);
  const back = vcardToContact(v);
  const d = diffContacts(m, back);
  assertEquals(d, { set: [], del: [] }, "no changes after roundtrip");
});

Deno.test("contacts: GAL hit becomes a vCard", () => {
  const contact = parseXml(`<t:Contact xmlns:t="t"><t:DisplayName>Schmidt, Anna</t:DisplayName><t:Department>IT-Service</t:Department><t:PhoneNumbers><t:Entry Key="BusinessPhone">+49 231 755 0</t:Entry></t:PhoneNumbers></t:Contact>`);
  const v = galEntryToVCard({ name: "Schmidt, Anna", email: "anna.schmidt@tu-dortmund.de", contact });
  assert(v.includes("FN:Schmidt\\, Anna") && v.includes("anna.schmidt@tu-dortmund.de") && v.includes("ORG:;IT-Service"), v);
});

Deno.test("carddav: create, read, update, delete via DAV", async () => {
  const ex = new MockExchange();
  const server = ex.serve();
  try {
    const ews = new EwsClient({ url: ex.url, transport: basicTransport("user", "secret") });
    const book = new ExchangeAddressBook({ ews, store: new MemoryStore(), key: "ab", id: "contacts", folder: "@contacts", displayName: "Contacts", minSyncIntervalMs: 0 });
    const ctx = { key: "k", email: "user@example.org", calendars: [], addressBooks: [book] };
    const dav = new DavServer({ authenticate: async () => ctx });
    const req = (method, path, body = "", headers = {}) => dav.handle({ method, path, headers: { authorization: "Basic " + btoa("a:b"), ...headers }, body: utf8Encode(body) });
    let r = await req("PROPFIND", "/addressbooks/k/", `<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`, { depth: "1" });
    assert(r.body.includes("<card:addressbook/>"), r.body);
    r = await req("PUT", "/addressbooks/k/contacts/3f1c2a9e-tb.vcf", TB_VCARD, { "if-none-match": "*" });
    assertEquals(r.status, 201);
    const [c] = ex.itemsIn("contacts");
    assert(c.props.get("EmailAddresses").includes("joerg.mueller@tu-dortmund.de"));
    r = await req("GET", "/addressbooks/k/contacts/3f1c2a9e-tb.vcf");
    assert(r.body.includes("UID:3f1c2a9e-tb"), "Thunderbird's UID is preserved: " + r.body);
    assert(r.body.includes("ORG:TU Dortmund;Informatik"), r.body);
    const updated = TB_VCARD.replace("+49 170 1234567", "+49 171 0000000").replace("EMAIL;TYPE=home:jm@example.de\r\n", "");
    r = await req("PUT", "/addressbooks/k/contacts/3f1c2a9e-tb.vcf", updated, { "if-match": r.headers.ETag });
    assertEquals(r.status, 204);
    assert(c.props.get("PhoneNumbers").includes("+49 171 0000000"), c.props.get("PhoneNumbers"));
    assert(!c.props.get("EmailAddresses").includes("jm@example.de"), c.props.get("EmailAddresses"));
    assert(c.props.get("PhoneNumbers").includes("+49 231 755-1234"), "untouched entries kept");
    r = await req("REPORT", "/addressbooks/k/contacts/", `<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><d:href>/addressbooks/k/contacts/3f1c2a9e-tb.vcf</d:href></card:addressbook-multiget>`);
    assert(r.body.includes("+49 171 0000000"), r.body);
    r = await req("DELETE", "/addressbooks/k/contacts/3f1c2a9e-tb.vcf");
    assertEquals(r.status, 204);
    assertEquals(ex.itemsIn("contacts").length, 0);
  } finally {
    await server.shutdown();
  }
});

import { assertEquals, assert } from "./assert.mjs";
import { parseXml, xmlEscape, tag } from "../core/xml.mjs";
import * as U from "../core/util.mjs";
import * as M from "../core/mime.mjs";
import { encodeMUTF7, decodeMUTF7 } from "../core/imap/mutf7.mjs";

Deno.test("xml: namespaces, entities, cdata", () => {
  const x = parseXml(`<?xml version="1.0"?>
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
    <m:R xmlns:m="urn:m" ResponseClass="Success"><t:Subject xmlns:t="urn:t">A &amp; B &#x263A;</t:Subject>
    <t:Raw><![CDATA[<x>]]></t:Raw><t:Empty/></m:R></s:Body></s:Envelope>`);
  assertEquals(x.name, "Envelope");
  const r = x.path("Body", "R");
  assertEquals(r.attr("ResponseClass"), "Success");
  assertEquals(r.ns, "urn:m");
  assertEquals(r.childText("Subject"), "A & B ☺");
  assertEquals(r.childText("Raw"), "<x>");
  assertEquals(r.child("Empty").text, "");
  assertEquals(x.findAll("Subject").length, 1);
});

Deno.test("xml: escape and tag builder", () => {
  assertEquals(xmlEscape(`<a href="x">&'</a>\x01`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  assertEquals(tag("t:X", { Id: "1&2" }, "c"), `<t:X Id="1&amp;2">c</t:X>`);
  assertEquals(tag("t:X"), "<t:X/>");
});

Deno.test("util: base64 and utf8 roundtrip", () => {
  for (const s of ["", "a", "ab", "abc", "abcd", "\x00\xff\x80binary"]) {
    assertEquals(U.base64Decode(U.base64Encode(s)), s);
  }
  assertEquals(U.base64Encode("Man"), "TWFu");
  assertEquals(U.utf8Decode(U.utf8Encode("Grüße ☺ 𝄞")), "Grüße ☺ 𝄞");
});

Deno.test("mutf7", () => {
  assertEquals(encodeMUTF7("Gelöschte Elemente"), "Gel&APY-schte Elemente");
  assertEquals(decodeMUTF7("Gel&APY-schte Elemente"), "Gelöschte Elemente");
  assertEquals(encodeMUTF7("A&B"), "A&-B");
  assertEquals(decodeMUTF7("A&-B"), "A&B");
  assertEquals(decodeMUTF7(encodeMUTF7("日本語 𝄞 Entwürfe")), "日本語 𝄞 Entwürfe");
});

Deno.test("mime: header decode/encode", () => {
  assertEquals(M.decodeHeaderValue("=?UTF-8?Q?Gr=C3=BC=C3=9Fe?= =?UTF-8?B?IFdlbHQ=?="), "Grüße Welt");
  assertEquals(M.decodeHeaderValue("=?iso-8859-1?q?M=FCller?="), "Müller");
  const enc = M.encodeHeaderValue("Besprechung über Prüfungen – nächste Woche, bitte bestätigen!");
  assert(/^[\x20-\x7e]+$/.test(enc));
  assertEquals(M.decodeHeaderValue(enc), "Besprechung über Prüfungen – nächste Woche, bitte bestätigen!");
});

Deno.test("mime: address lists", () => {
  const l = M.parseAddressList(`"Müller, Hans" <hans@example.org>, bob@example.com, =?UTF-8?Q?J=C3=B6rg?= <j@x.de>, Team: a@x.de, b@x.de;, old@x.de (Old Name)`);
  assertEquals(l.map(a => [a.name, a.email]), [
    ["Müller, Hans", "hans@example.org"],
    ["", "bob@example.com"],
    ["Jörg", "j@x.de"],
    ["", "a@x.de"],
    ["", "b@x.de"],
    ["Old Name", "old@x.de"],
  ]);
  assertEquals(M.formatAddress({ name: "Müller, Hans", email: "h@x.de" }).endsWith("<h@x.de>"), true);
  assertEquals(M.formatAddress({ name: "Doe, John", email: "j@x.de" }), `"Doe, John" <j@x.de>`);
});

Deno.test("mime: params with RFC 2231", () => {
  const p = M.parseParamHeader(`attachment; filename*0*=utf-8''Pr%C3%BC; filename*1="fung.pdf"; size=12`);
  assertEquals(p.value, "attachment");
  assertEquals(p.params.filename, "Prüfung.pdf");
  assertEquals(p.params.size, "12");
});

const SAMPLE = [
  "From: A <a@x.de>",
  "To: b@x.de",
  "Subject: Test",
  "Date: Tue, 1 Sep 2026 10:00:00 +0000",
  "Message-ID: <m1@x>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="BB"',
  "",
  "preamble",
  "--BB",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello",
  "World",
  "--BB",
  "Content-Type: application/pdf; name=a.pdf",
  "Content-Disposition: attachment; filename=a.pdf",
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0=",
  "--BB",
  "Content-Type: message/rfc822",
  "",
  "Subject: Inner",
  "From: c@x.de",
  "",
  "inner body",
  "--BB--",
  "",
].join("\r\n");

Deno.test("mime: tree, sections, bodystructure", () => {
  const root = M.parseMime(SAMPLE);
  assertEquals(root.type, "multipart");
  assertEquals(root.children.length, 3);
  const p1 = M.resolvePart(root, [1]);
  assertEquals(SAMPLE.slice(p1.bodyStart, p1.end), "Hello\r\nWorld");
  const p2 = M.resolvePart(root, [2]);
  assertEquals(SAMPLE.slice(p2.bodyStart, p2.end), "JVBERi0=");
  const p3 = M.resolvePart(root, [3]);
  assert(p3.message);
  assertEquals(p3.message.headers.get("Subject"), "Inner");
  const inner1 = M.resolvePart(root, [3, 1]);
  assertEquals(SAMPLE.slice(inner1.bodyStart, inner1.end), "inner body");
  const q = s => `"${s}"`;
  const bs = M.bodyStructure(SAMPLE, root, q);
  assert(bs.startsWith('(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 2'), bs);
  assert(bs.includes('("ATTACHMENT" ("FILENAME" "a.pdf"))'), bs);
  assert(bs.includes('"MIXED" ("BOUNDARY" "BB")'), bs);
  assertEquals(M.extractText(SAMPLE), "Hello\r\nWorld");
});

Deno.test("mime: single part and setHeader", () => {
  const msg = "Subject: x\r\nFrom: a@b\r\n\r\nbody\r\n";
  const root = M.parseMime(msg);
  assertEquals(root.type, "text");
  const p = M.resolvePart(root, [1]);
  assertEquals(msg.slice(p.bodyStart, p.end), "body\r\n");
  const m2 = M.setHeader(msg, "Bcc", "c@d");
  assertEquals(m2, "Subject: x\r\nFrom: a@b\r\nBcc: c@d\r\n\r\nbody\r\n");
  assertEquals(M.setHeader(m2, "Bcc", null), msg);
});

Deno.test("mime: dates", () => {
  assertEquals(M.formatRfc2822Date(Date.UTC(2026, 8, 10, 7, 5, 3)), "Thu, 10 Sep 2026 07:05:03 +0000");
  assertEquals(M.formatImapDate(Date.UTC(2026, 8, 1, 7, 5, 3)), "01-Sep-2026 07:05:03 +0000");
  assertEquals(M.parseImapSearchDate("1-Feb-1994").toISOString(), "1994-02-01T00:00:00.000Z");
  assertEquals(M.parseImapDateTime("17-Jul-1996 02:44:25 -0700").toISOString(), "1996-07-17T09:44:25.000Z");
});

import { assert, assertEquals } from "./assert.mjs";
import { parseXml } from "../core/xml.mjs";
import { parseCalendar, serialize, parseComponents } from "../core/cal/ical.mjs";
import { ewsToModel, modelToIcal, icalToModel, modelToCreateXml, diffModels, ConversionError } from "../core/cal/convert.mjs";
import { zonedToUtc, utcToZoned, toIana, toWindows } from "../core/cal/tz.mjs";
import { MockExchange, basicTransport } from "./mock-ews.mjs";
import { EwsClient } from "../core/ews/client.mjs";
import { ExchangeCalendar } from "../core/cal/calendar.mjs";
import { DavServer } from "../core/dav/server.mjs";
import { HttpSession } from "../core/dav/http.mjs";
import { MemoryStore } from "../core/store.mjs";
import { utf8Encode, utf8Decode } from "../core/util.mjs";
import { TestConn } from "./imap-harness.mjs";

const ewsItem = xml => parseXml(`<t:CalendarItem xmlns:t="t">${xml}</t:CalendarItem>`);

Deno.test("tz: conversions across DST and mapping", () => {
  // 09:00 Berlin in summer = 07:00Z, in winter = 08:00Z
  assertEquals(new Date(zonedToUtc({ y: 2026, m: 7, d: 1, h: 9 }, "Europe/Berlin")).toISOString(), "2026-07-01T07:00:00.000Z");
  assertEquals(new Date(zonedToUtc({ y: 2026, m: 12, d: 1, h: 9 }, "Europe/Berlin")).toISOString(), "2026-12-01T08:00:00.000Z");
  assertEquals(utcToZoned(Date.UTC(2026, 9, 25, 1, 30), "Europe/Berlin").h, 2); // after fall-back
  assertEquals(toIana("W. Europe Standard Time"), "Europe/Berlin");
  assertEquals(toWindows("Europe/Berlin"), "W. Europe Standard Time");
  assertEquals(toWindows("Europe/Amsterdam"), "W. Europe Standard Time");
  assertEquals(toWindows("America/New_York"), "Eastern Standard Time");
  assertEquals(toIana("Europe/Paris"), "Europe/Paris");
});

Deno.test("ical: parse/serialize roundtrip with folding, params and escapes", () => {
  const text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Mittag\\, Kantine\; Raum 1\r\nATTENDEE;CN=\"Müller, Hans\";PARTSTAT=ACCEPTED:mailto:h@x.de\r\nDESCRIPTION:line one\\nline two which is quite long and will need folding when serialized again ok\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const cal = parseCalendar(text);
  const ev = cal.sub("VEVENT")[0];
  assertEquals(ev.get("ATTENDEE").params.CN, "Müller, Hans");
  const out = serialize(cal);
  assert(out.split("\r\n").every(l => new TextEncoder().encode(l).length <= 75), out);
  const again = parseCalendar(out).sub("VEVENT")[0];
  assertEquals(again.value("DESCRIPTION"), ev.value("DESCRIPTION"));
  assertEquals(again.get("ATTENDEE").params.CN, "Müller, Hans");
});

Deno.test("convert: EWS weekly meeting -> iCal with TZID, RRULE, EXDATE, attendees, alarm", () => {
  const model = ewsToModel(ewsItem(`
    <t:ItemId Id="I1" ChangeKey="C1"/><t:Subject>Team</t:Subject><t:Body BodyType="Text">Agenda</t:Body>
    <t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>10</t:ReminderMinutesBeforeStart>
    <t:UID>UID-1</t:UID><t:Start>2026-09-07T07:00:00Z</t:Start><t:End>2026-09-07T08:00:00Z</t:End>
    <t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:Location>R 1.23</t:Location>
    <t:IsMeeting>true</t:IsMeeting><t:MyResponseType>Organizer</t:MyResponseType>
    <t:Organizer><t:Mailbox><t:Name>Me</t:Name><t:EmailAddress>user@example.org</t:EmailAddress></t:Mailbox></t:Organizer>
    <t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Anna</t:Name><t:EmailAddress>anna@example.org</t:EmailAddress></t:Mailbox><t:ResponseType>Accept</t:ResponseType></t:Attendee></t:RequiredAttendees>
    <t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday Thursday</t:DaysOfWeek><t:FirstDayOfWeek>Monday</t:FirstDayOfWeek></t:WeeklyRecurrence><t:EndDateRecurrence><t:StartDate>2026-09-07+02:00</t:StartDate><t:EndDate>2026-12-17+01:00</t:EndDate></t:EndDateRecurrence></t:Recurrence>
    <t:DeletedOccurrences><t:DeletedOccurrence><t:Start>2026-09-10T07:00:00Z</t:Start></t:DeletedOccurrence></t:DeletedOccurrences>
    <t:StartTimeZone Id="W. Europe Standard Time"/>`));
  const text = serialize(modelToIcal(model, { ownEmail: "user@example.org" })).replace(/\r\n /g, "");
  assert(text.includes("DTSTART;TZID=Europe/Berlin:20260907T090000"), text);
  assert(text.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,TH;WKST=MO;UNTIL=20261217T225959Z"), text);
  assert(text.includes("EXDATE;TZID=Europe/Berlin:20260910T090000"), text);
  assert(text.includes("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Anna:mailto:anna@example.org"), text);
  assert(text.includes("ORGANIZER;CN=Me:mailto:user@example.org"), text);
  assert(text.includes("TRIGGER;RELATED=START:-PT10M"), text);
  // and back
  const back = icalToModel(parseCalendar(text), { defaultTz: "UTC" });
  assertEquals(back.start, model.start);
  assertEquals(back.recurrence.freq, "weekly");
  assertEquals(back.recurrence.days, ["Monday", "Thursday"]);
  assertEquals(back.recurrence.range, { type: "endDate", startDate: "2026-09-07", endDate: "2026-12-17" });
  assertEquals(back.deleted, [Date.parse("2026-09-10T07:00:00Z")]);
  assertEquals(back.reminder, 10);
  assertEquals(diffModels(model, back).set.length, 0, "no-op round trip produces no changes");
});

Deno.test("convert: all-day event uses DATE values in the event zone", () => {
  const model = ewsToModel(ewsItem(`<t:ItemId Id="I" ChangeKey="C"/><t:Subject>Urlaub</t:Subject><t:UID>u</t:UID><t:Start>2026-09-09T22:00:00Z</t:Start><t:End>2026-09-11T22:00:00Z</t:End><t:IsAllDayEvent>true</t:IsAllDayEvent><t:LegacyFreeBusyStatus>OOF</t:LegacyFreeBusyStatus><t:StartTimeZone Id="W. Europe Standard Time"/>`));
  const text = serialize(modelToIcal(model, {}));
  assert(text.includes("DTSTART;VALUE=DATE:20260910"), text);
  assert(text.includes("DTEND;VALUE=DATE:20260912"), text);
  assert(text.includes("X-MICROSOFT-CDO-BUSYSTATUS:OOF"), text);
  const back = icalToModel(parseCalendar(text), { defaultTz: "Europe/Berlin" });
  assertEquals(back.start, model.start);
  assertEquals(back.busy, "OOF");
});

Deno.test("convert: RRULE variants map to EWS patterns, unsupported ones are rejected", () => {
  const mk = rrule => icalToModel(parseCalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r\r\nDTSTART;TZID=Europe/Berlin:20260915T100000\r\nDTEND;TZID=Europe/Berlin:20260915T110000\r\nRRULE:${rrule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`), { defaultTz: "UTC" }).recurrence;
  assertEquals(mk("FREQ=MONTHLY;BYDAY=3TU").freq, "relMonthly");
  assertEquals(mk("FREQ=MONTHLY;BYDAY=3TU").index, "Third");
  assertEquals(mk("FREQ=MONTHLY;BYDAY=-1FR").index, "Last");
  assertEquals(mk("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1").days, ["Weekday"]);
  assertEquals(mk("FREQ=MONTHLY").dayOfMonth, 15);
  assertEquals(mk("FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=15").month, "September");
  assertEquals(mk("FREQ=DAILY;INTERVAL=2;COUNT=5").range, { type: "numbered", startDate: "2026-09-15", count: 5 });
  assertEquals(mk("FREQ=WEEKLY").days, ["Tuesday"]);
  assertEquals(mk("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR").freq, "weekly");
  let threw = false;
  try { mk("FREQ=HOURLY"); } catch (e) { threw = e instanceof ConversionError; }
  assert(threw, "hourly must be rejected");
});

Deno.test("convert: CreateItem XML follows schema order (mock validates)", () => {
  const model = icalToModel(parseCalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:S\r\nLOCATION:L\r\nDESCRIPTION:D\r\nCATEGORIES:A,B\r\nDTSTART;TZID=Europe/Berlin:20260915T100000\r\nDTEND;TZID=Europe/Berlin:20260915T110000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nATTENDEE:mailto:a@x.de\r\nBEGIN:VALARM\r\nTRIGGER:-PT5M\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`), {});
  const xml = modelToCreateXml(model);
  const names = parseXml(xml.replace("<t:CalendarItem>", '<t:CalendarItem xmlns:t="t">')).elements().map(e => e.name);
  assertEquals(names, ["Subject", "Sensitivity", "Body", "Categories", "Importance", "ReminderIsSet", "ReminderMinutesBeforeStart", "UID", "Start", "End", "IsAllDayEvent", "LegacyFreeBusyStatus", "Location", "RequiredAttendees", "Recurrence", "StartTimeZone", "EndTimeZone"]);
});

// ---------------------------------------------------------------------------
// CalDAV end to end

function setupDav() {
  const ex = new MockExchange();
  const server = ex.serve();
  const ews = new EwsClient({ url: ex.url, transport: basicTransport("user", "secret") });
  const cal = new ExchangeCalendar({ ews, store: new MemoryStore(), key: "cal", id: "default", folder: "@calendar", displayName: "Calendar", ownEmail: "user@example.org", defaultTz: "Europe/Berlin", minSyncIntervalMs: 0 });
  const ctx = { key: "acct1", email: "user@example.org", displayName: "Test User", calendars: [cal], addressBooks: [] };
  const dav = new DavServer({ authenticate: async (u, p) => (p == "tok" ? ctx : null) });
  const auth = "Basic " + btoa("user@example.org:tok");
  const req = async (method, path, body = "", headers = {}) => {
    const res = await dav.handle({ method, path, headers: { authorization: auth, ...headers }, body: utf8Encode(body) });
    return { ...res, text: res.body };
  };
  return { ex, server, ews, cal, dav, req };
}

const EVENT = (uid, summary, extra = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART;TZID=Europe/Berlin:20260915T100000\r\nDTEND;TZID=Europe/Berlin:20260915T113000\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;

Deno.test("caldav: discovery (principal, home, collection)", async () => {
  const t = setupDav();
  try {
    let r = await t.dav.handle({ method: "PROPFIND", path: "/principals/acct1/", headers: {}, body: "" });
    assertEquals(r.status, 401);
    r = await t.req("OPTIONS", "/calendars/acct1/default/");
    assert(r.headers.DAV.includes("calendar-auto-schedule"));
    r = await t.req("PROPFIND", "/principals/acct1/", `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><c:calendar-user-address-set/><c:schedule-inbox-URL/></d:prop></d:propfind>`);
    assertEquals(r.status, 207);
    assert(r.text.includes("<c:calendar-home-set><d:href>/calendars/acct1/</d:href>"), r.text);
    assert(r.text.includes("mailto:user@example.org"), r.text);
    assert(/404 Not Found/.test(r.text) && r.text.includes("schedule-inbox-URL"), r.text);
    r = await t.req("PROPFIND", "/calendars/acct1/", `<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:resourcetype/><d:displayname/><cs:getctag/></d:prop></d:propfind>`, { depth: "1" });
    assert(r.text.includes("/calendars/acct1/default/") && r.text.includes("<c:calendar/>"), r.text);
  } finally {
    await t.server.shutdown();
  }
});

Deno.test("caldav: create, read, modify, delete a timed event", async () => {
  const t = setupDav();
  try {
    let r = await t.req("PUT", "/calendars/acct1/default/new-1.ics", EVENT("tb-uid-1", "Sprechstunde", "LOCATION:Raum 1\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n"), { "if-none-match": "*" });
    assertEquals(r.status, 201, r.text);
    const etag1 = r.headers.ETag;
    const [item] = t.ex.itemsIn("calendar");
    assert(item.props.get("Start").includes("2026-09-15T08:00:00Z"), item.props.get("Start"));
    assert(item.props.get("StartTimeZone").includes("W. Europe Standard Time"));
    assert(item.props.get("UID").includes("tb-uid-1"));

    r = await t.req("PROPFIND", "/calendars/acct1/default/", `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`, { depth: "1" });
    assert(r.text.includes("/calendars/acct1/default/new-1.ics"), r.text);

    r = await t.req("GET", "/calendars/acct1/default/new-1.ics");
    assertEquals(r.status, 200);
    assert(r.text.includes("DTSTART;TZID=Europe/Berlin:20260915T100000"), r.text);
    assert(r.text.includes("SUMMARY:Sprechstunde") && r.text.includes("LOCATION:Raum 1"), r.text);
    assert(r.text.includes("TRIGGER;RELATED=START:-PT15M"), r.text);

    r = await t.req("PUT", "/calendars/acct1/default/new-1.ics", EVENT("tb-uid-1", "Sprechstunde (verschoben)"), { "if-match": '"stale"' });
    assertEquals(r.status, 412);
    r = await t.req("PUT", "/calendars/acct1/default/new-1.ics", EVENT("tb-uid-1", "Sprechstunde (verschoben)", "LOCATION:Raum 1\r\n"), { "if-match": etag1 });
    assertEquals(r.status, 204, r.text);
    assert(item.props.get("Subject").includes("verschoben"));
    assert(!item.props.has("ReminderMinutesBeforeStart") || item.props.get("ReminderIsSet").includes("false"), "reminder removed");

    r = await t.req("REPORT", "/calendars/acct1/default/", `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/calendars/acct1/default/new-1.ics</d:href><d:href>/calendars/acct1/default/missing.ics</d:href></c:calendar-multiget>`);
    assert(r.text.includes("verschoben") && r.text.includes("missing.ics</d:href><d:status>HTTP/1.1 404"), r.text);

    r = await t.req("DELETE", "/calendars/acct1/default/new-1.ics");
    assertEquals(r.status, 204);
    assertEquals(t.ex.itemsIn("calendar").length, 0);
    assertEquals(t.ex.sent.filter(s => s.cancel).length, 0, "no cancellation for a plain appointment");
  } finally {
    await t.server.shutdown();
  }
});

Deno.test("caldav: meeting as organizer sends invitations, update and cancel", async () => {
  const t = setupDav();
  try {
    const att = "ORGANIZER;CN=Test User:mailto:user@example.org\r\nATTENDEE;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:user@example.org\r\nATTENDEE;CN=Anna;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:anna@example.org\r\n";
    let r = await t.req("PUT", "/calendars/acct1/default/m.ics", EVENT("meet-1", "Projekt", att), { "if-none-match": "*" });
    assertEquals(r.status, 201, r.text);
    assertEquals(t.ex.sent.length, 1);
    assertEquals(t.ex.sent[0].attendees, ["anna@example.org"], "organizer is not invited to own meeting");
    r = await t.req("PUT", "/calendars/acct1/default/m.ics", EVENT("meet-1", "Projekt", att + "LOCATION:Online\r\n"));
    assertEquals(r.status, 204);
    assert(t.ex.sent.some(s => s.update), "location change notifies attendees");
    const n = t.ex.sent.length;
    r = await t.req("PUT", "/calendars/acct1/default/m.ics", EVENT("meet-1", "Projekt", att + "LOCATION:Online\r\nCATEGORIES:Lehre\r\n"));
    assertEquals(t.ex.sent.length, n, "category change is not significant");
    r = await t.req("DELETE", "/calendars/acct1/default/m.ics");
    assert(t.ex.sent.some(s => s.cancel), "cancellation sent");
  } finally {
    await t.server.shutdown();
  }
});

Deno.test("caldav: attendee accepts invitation (PARTSTAT -> AcceptItem)", async () => {
  const t = setupDav();
  try {
    // Exchange put an invitation into the calendar
    const cal = t.ex.folder("calendar");
    t.ex.handle(`<s:Envelope xmlns:s="x"><s:Body><m:CreateItem xmlns:m="m" xmlns:t="t" SendMeetingInvitations="SendToNone"><m:SavedItemFolderId><t:FolderId Id="${cal.id}"/></m:SavedItemFolderId><m:Items><t:CalendarItem><t:Subject>Kolloquium</t:Subject><t:UID>inv-1</t:UID><t:Start>2026-09-20T12:00:00Z</t:Start><t:End>2026-09-20T13:00:00Z</t:End><t:RequiredAttendees><t:Attendee><t:Mailbox><t:EmailAddress>user@example.org</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees></t:CalendarItem></m:Items></m:CreateItem></s:Body></s:Envelope>`);
    const [item] = t.ex.itemsIn("calendar");
    item.props.set("Organizer", "<t:Organizer><t:Mailbox><t:Name>Prof</t:Name><t:EmailAddress>prof@example.org</t:EmailAddress></t:Mailbox></t:Organizer>");
    item.props.set("MyResponseType", "<t:MyResponseType>NoResponseReceived</t:MyResponseType>");
    item.props.set("IsMeeting", "<t:IsMeeting>true</t:IsMeeting>");
    let r = await t.req("PROPFIND", "/calendars/acct1/default/", `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`, { depth: "1" });
    const href = /\/calendars\/acct1\/default\/([0-9a-f]+\.ics)/.exec(r.text)[1];
    r = await t.req("GET", `/calendars/acct1/default/${href}`);
    assert(r.text.includes("ORGANIZER;CN=Prof:mailto:prof@example.org"), r.text);
    assert(r.text.includes("PARTSTAT=NEEDS-ACTION"), r.text);
    const accepted = r.text.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED").replace("SUMMARY:Kolloquium", "SUMMARY:Kolloquium (moved by me)");
    r = await t.req("PUT", `/calendars/acct1/default/${href}`, accepted);
    assertEquals(r.status, 204, r.text);
    assertEquals(t.ex.responses, [{ id: item.id, response: "Accept", send: true }]);
    assert(item.props.get("Subject").includes("<t:Subject>Kolloquium</t:Subject>"), "attendee cannot rename the meeting");
    // Thunderbird adds the same invitation under its own href (iMIP): adopt by UID
    r = await t.req("PUT", "/calendars/acct1/default/tb-own.ics", accepted.replace("PARTSTAT=ACCEPTED", "PARTSTAT=TENTATIVE"), { "if-none-match": "*" });
    assertEquals(r.status, 201, r.text);
    assertEquals(t.ex.itemsIn("calendar").length, 1, "no duplicate event");
    assertEquals(t.ex.responses[1].response, "Tentative");
  } finally {
    await t.server.shutdown();
  }
});

Deno.test("caldav: recurring event with exception and deleted occurrence", async () => {
  const t = setupDav();
  try {
    // Weekly on Tuesdays 10:00 Berlin (08:00Z, summer), 4 times
    const master = "RRULE:FREQ=WEEKLY;COUNT=4\r\n";
    let r = await t.req("PUT", "/calendars/acct1/default/rec.ics", EVENT("rec-1", "Seminar", master), { "if-none-match": "*" });
    assertEquals(r.status, 201, r.text);
    const ical = EVENT("rec-1", "Seminar", master + "EXDATE;TZID=Europe/Berlin:20260929T100000\r\n").replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\r\nUID:rec-1\r\nRECURRENCE-ID;TZID=Europe/Berlin:20260922T100000\r\nSUMMARY:Seminar (Hörsaal 2)\r\nDTSTART;TZID=Europe/Berlin:20260922T140000\r\nDTEND;TZID=Europe/Berlin:20260922T153000\r\nEND:VEVENT\r\nEND:VCALENDAR"
    );
    r = await t.req("PUT", "/calendars/acct1/default/rec.ics", ical);
    assertEquals(r.status, 204, r.text);
    const [m] = t.ex.itemsIn("calendar");
    assertEquals(m.deletedOcc, [Date.parse("2026-09-29T08:00:00Z")]);
    assertEquals(m.exceptions.length, 1);
    r = await t.req("GET", "/calendars/acct1/default/rec.ics");
    assert(r.text.includes("RECURRENCE-ID;TZID=Europe/Berlin:20260922T100000"), r.text);
    assert(r.text.includes("SUMMARY:Seminar (Hörsaal 2)"), r.text);
    assert(r.text.includes("DTSTART;TZID=Europe/Berlin:20260922T140000"), r.text);
    assert(r.text.includes("EXDATE;TZID=Europe/Berlin:20260929T100000"), r.text);
    assert(r.text.includes("RRULE:FREQ=WEEKLY;BYDAY=TU;WKST=MO;COUNT=4"), r.text);
    // Round-trip of the served data must not cause changes
    const before = t.ex.requests.filter(x => x == "UpdateItem").length;
    r = await t.req("PUT", "/calendars/acct1/default/rec.ics", r.text);
    assertEquals(t.ex.requests.filter(x => x == "UpdateItem").length, before, "idempotent PUT");
  } finally {
    await t.server.shutdown();
  }
});

Deno.test("http: session parses pipelined and chunked requests", async () => {
  const conn = new TestConn();
  const seen = [];
  const s = new HttpSession({ conn, handler: async req => { seen.push([req.method, req.path, utf8Decode(req.body)]); return { status: 200, body: "ü" }; } });
  s.data("GET /a HTTP/1.1\r\nHost: x\r\n\r\nPUT /b HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\n");
  s.data(utf8Encode("é") + "\r\n0\r\n\r\n");
  for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise(r => setTimeout(r, 2));
  await new Promise(r => setTimeout(r, 5));
  assertEquals(seen, [["GET", "/a", ""], ["PUT", "/b", "abcé"]]);
  assert(conn.out.includes("Content-Length: 2\r\n"), conn.out); // "ü" is 2 bytes in UTF-8
});

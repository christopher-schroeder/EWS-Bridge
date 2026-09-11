/* End-to-end test server: a seeded mock Exchange for a real Thunderbird.
 * Usage: deno run -A tests/e2e/server.mjs <port> <reportFile>
 * Also serves /e2e/report (POST, from the test extension) and /e2e/state.
 */

import { MockExchange } from "../mock-ews.mjs";

const port = parseInt(Deno.args[0] || "18443", 10);
const reportFile = Deno.args[1] || "e2e-report.json";

const ex = new MockExchange({ email: "anna.test@example.org", username: "EXAMPLE\\atest", password: "Geheim!123", name: "Anna Test" });
const mime = (subj, body, extra = "") =>
  `From: "Prof. Müller" <mueller@example.org>\r\nTo: anna.test@example.org\r\nSubject: ${subj}\r\nDate: Wed, 9 Sep 2026 08:15:00 +0000\r\nMessage-ID: <${subj.replace(/\W/g, "")}@example.org>\r\nMIME-Version: 1.0\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
ex.addMessage("inbox", mime("Klausurtermine WiSe", "Die Klausur findet am 12.02. statt."), { received: new Date("2026-09-09T08:15:00Z") });
ex.addMessage("inbox", mime("Seminar Anmeldung", "Bitte bis Freitag anmelden."), { isRead: true, received: new Date("2026-09-09T09:00:00Z") });
ex.addMessage("inbox", mime("Großes Paket", "x".repeat(200000)), { received: new Date("2026-09-09T10:00:00Z") });
ex.addMessage("sentitems", mime("Re: Ältere Mail", "sent before"), { isRead: true });

// Calendar: a weekly lecture (Europe/Berlin) created through EWS as Outlook would.
ex.handle(`<s:Envelope xmlns:s="x"><s:Body><m:CreateItem xmlns:m="m" xmlns:t="t" SendMeetingInvitations="SendToNone"><m:Items><t:CalendarItem><t:Subject>Vorlesung Datenbanken</t:Subject><t:Body BodyType="Text">Hörsaal 1</t:Body><t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>15</t:ReminderMinutesBeforeStart><t:UID>e2e-lecture-uid</t:UID><t:Start>2026-09-14T08:00:00Z</t:Start><t:End>2026-09-14T09:30:00Z</t:End><t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:Location>HS 1</t:Location><t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday</t:DaysOfWeek></t:WeeklyRecurrence><t:NumberedRecurrence><t:StartDate>2026-09-14</t:StartDate><t:NumberOfOccurrences>10</t:NumberOfOccurrences></t:NumberedRecurrence></t:Recurrence><t:StartTimeZone Id="W. Europe Standard Time"/><t:EndTimeZone Id="W. Europe Standard Time"/></t:CalendarItem></m:Items></m:CreateItem></s:Body></s:Envelope>`);
// Contacts
ex.handle(`<s:Envelope xmlns:s="x"><s:Body><m:CreateItem xmlns:m="m" xmlns:t="t"><m:Items><t:Contact><t:FileAs>Schmidt, Bernd</t:FileAs><t:DisplayName>Bernd Schmidt</t:DisplayName><t:GivenName>Bernd</t:GivenName><t:CompanyName>Lehrstuhl 1</t:CompanyName><t:EmailAddresses><t:Entry Key="EmailAddress1">bernd.schmidt@example.org</t:Entry></t:EmailAddresses><t:PhoneNumbers><t:Entry Key="BusinessPhone">+49 231 1234</t:Entry></t:PhoneNumbers><t:Surname>Schmidt</t:Surname></t:Contact></m:Items></m:CreateItem></s:Body></s:Envelope>`);
// Directory (GAL)
ex.directory.push(
  { name: "Weber, Clara", email: "clara.weber@example.org", department: "Rechenzentrum", phone: "+49 231 5555" },
  { name: "Wegener, Dirk", email: "dirk.wegener@example.org", department: "Dekanat" }
);

let report = null;
const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, async req => {
  const url = new URL(req.url);
  if (url.pathname == "/e2e/report") {
    report = await req.json();
    await Deno.writeTextFile(reportFile, JSON.stringify({ report, state: snapshot() }, null, 2));
    return new Response("ok");
  }
  if (url.pathname == "/e2e/log") {
    console.log("[tb] " + (await req.text()));
    return new Response("ok");
  }
  if (url.pathname == "/e2e/state") {
    return Response.json(snapshot());
  }
  const res = await ex.fetchHandler(req);
  console.log(`[ews] ${ex.requests[ex.requests.length - 1] || url.pathname} → ${res.status}`);
  return res;
});

function snapshot() {
  const items = folder => ex.itemsIn(folder).map(i => ({
    subject: (i.props.get("Subject") || "").replace(/<[^>]+>/g, ""),
    isRead: i.isRead,
    flag: i.ext["0x1090"] || null,
    kind: i.kind,
  }));
  return {
    inbox: items("inbox"),
    deleted: items("deleteditems"),
    sent: ex.sent.map(s => (s.mime ? { mime: s.mime.slice(0, 2000) } : s)),
    sentItems: items("sentitems"),
    calendar: items("calendar"),
    contacts: items("contacts"),
    requests: ex.requests.reduce((m, r) => ((m[r] = (m[r] || 0) + 1), m), {}),
  };
}

console.log(`mock exchange on http://127.0.0.1:${server.addr.port}/EWS/Exchange.asmx`);

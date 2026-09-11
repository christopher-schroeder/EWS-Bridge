/* EWS Bridge — Exchange calendar items <-> iCalendar VEVENTs.
 *
 * Both directions go through a neutral "event model":
 *   { uid, subject, body, location, start, end (ms UTC), allDay, tz (IANA),
 *     reminder (minutes|null), categories[], sensitivity, busy, importance,
 *     organizer, required[], optional[], resources[], myResponse, isMeeting,
 *     cancelled, sequence, recurrence|null, deleted[ms], exceptions[] }
 */

import { Component, escapeText, unescapeText, splitList, parseDateValue, formatDate, formatDateTime, formatUtc, parseDuration, formatDuration } from "./ical.mjs";
import { toIana, toWindows, utcToZoned, zonedToUtc } from "./tz.mjs";
import { xmlEscape, tag, textTag } from "../xml.mjs";
import { parseMailbox } from "../ews/items.mjs";

export class ConversionError extends Error {}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const INDEX = ["First", "Second", "Third", "Fourth"];

const PARTSTAT = {
  Accept: "ACCEPTED",
  Tentative: "TENTATIVE",
  Decline: "DECLINED",
  Organizer: "ACCEPTED",
  NoResponseReceived: "NEEDS-ACTION",
  Unknown: "NEEDS-ACTION",
};
const RESPONSE_FROM_PARTSTAT = { ACCEPTED: "Accept", TENTATIVE: "Tentative", DECLINED: "Decline", "NEEDS-ACTION": "NoResponseReceived" };

function parseEwsDate(s) {
  if (!s) {
    return null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// EWS -> model

function parseAttendees(el) {
  if (!el) {
    return [];
  }
  return el.elements("Attendee").map(a => {
    const mb = parseMailbox(a.child("Mailbox"));
    return { name: mb.name, email: mb.email, response: a.childText("ResponseType") || "Unknown" };
  });
}

function parseRecurrence(el) {
  if (!el) {
    return null;
  }
  const [pattern, range] = el.elements();
  if (!pattern || !range) {
    return null;
  }
  const r = { interval: parseInt(pattern.childText("Interval") || "1", 10) || 1 };
  switch (pattern.name) {
    case "DailyRecurrence":
      r.freq = "daily";
      break;
    case "WeeklyRecurrence":
      r.freq = "weekly";
      r.days = (pattern.childText("DaysOfWeek") || "").split(/\s+/).filter(Boolean);
      r.firstDay = pattern.childText("FirstDayOfWeek");
      break;
    case "AbsoluteMonthlyRecurrence":
      r.freq = "absMonthly";
      r.dayOfMonth = parseInt(pattern.childText("DayOfMonth"), 10);
      break;
    case "RelativeMonthlyRecurrence":
      r.freq = "relMonthly";
      r.days = [pattern.childText("DaysOfWeek")];
      r.index = pattern.childText("DayOfWeekIndex");
      break;
    case "AbsoluteYearlyRecurrence":
      r.freq = "absYearly";
      r.dayOfMonth = parseInt(pattern.childText("DayOfMonth"), 10);
      r.month = pattern.childText("Month");
      r.interval = 1;
      break;
    case "RelativeYearlyRecurrence":
      r.freq = "relYearly";
      r.days = [pattern.childText("DaysOfWeek")];
      r.index = pattern.childText("DayOfWeekIndex");
      r.month = pattern.childText("Month");
      r.interval = 1;
      break;
    default:
      return null; // regeneration patterns are task-only
  }
  r.range = { startDate: (range.childText("StartDate") || "").slice(0, 10) };
  if (range.name == "EndDateRecurrence") {
    r.range.type = "endDate";
    r.range.endDate = (range.childText("EndDate") || "").slice(0, 10);
  } else if (range.name == "NumberedRecurrence") {
    r.range.type = "numbered";
    r.range.count = parseInt(range.childText("NumberOfOccurrences"), 10);
  } else {
    r.range.type = "noEnd";
  }
  return r;
}

/** Parse an EWS <t:CalendarItem> element into the model. */
export function ewsToModel(el, { defaultTz = "UTC" } = {}) {
  const tzEl = el.child("StartTimeZone") || el.child("MeetingTimeZone");
  const tzName = tzEl?.attr("Id") || tzEl?.attr("TimeZoneName") || el.childText("TimeZone");
  const tz = toIana(tzName, defaultTz);
  const cats = el.child("Categories");
  const body = el.child("Body");
  const idEl = el.child("ItemId");
  const model = {
    id: idEl?.attr("Id") ?? null,
    changeKey: idEl?.attr("ChangeKey") ?? null,
    uid: el.childText("UID"),
    subject: el.childText("Subject") ?? "",
    body: body ? body.text : null,
    bodyType: body?.attr("BodyType") || null,
    location: el.childText("Location"),
    start: parseEwsDate(el.childText("Start")),
    end: parseEwsDate(el.childText("End")),
    originalStart: parseEwsDate(el.childText("OriginalStart")),
    allDay: el.childText("IsAllDayEvent") == "true",
    tz,
    reminder: el.childText("ReminderIsSet") == "true" ? parseInt(el.childText("ReminderMinutesBeforeStart") || "15", 10) : null,
    categories: cats ? cats.elements("String").map(s => s.text) : [],
    sensitivity: el.childText("Sensitivity") || "Normal",
    busy: el.childText("LegacyFreeBusyStatus") || "Busy",
    importance: el.childText("Importance") || "Normal",
    organizer: el.child("Organizer") ? parseMailbox(el.child("Organizer").child("Mailbox")) : null,
    required: parseAttendees(el.child("RequiredAttendees")),
    optional: parseAttendees(el.child("OptionalAttendees")),
    resources: parseAttendees(el.child("Resources")),
    myResponse: el.childText("MyResponseType") || "Unknown",
    isMeeting: el.childText("IsMeeting") == "true",
    cancelled: el.childText("IsCancelled") == "true",
    type: el.childText("CalendarItemType") || "Single",
    sequence: parseInt(el.childText("AppointmentSequenceNumber") || "0", 10) || 0,
    created: parseEwsDate(el.childText("DateTimeCreated")),
    modified: parseEwsDate(el.childText("LastModifiedTime")),
    recurrence: parseRecurrence(el.child("Recurrence")),
    modifiedOccurrences: (el.child("ModifiedOccurrences")?.elements("Occurrence") || []).map(o => ({
      id: o.child("ItemId")?.attr("Id"),
      start: parseEwsDate(o.childText("Start")),
      end: parseEwsDate(o.childText("End")),
      originalStart: parseEwsDate(o.childText("OriginalStart")),
    })),
    deleted: (el.child("DeletedOccurrences")?.elements("DeletedOccurrence") || []).map(o => parseEwsDate(o.childText("Start"))).filter(x => x !== null),
    exceptions: [],
  };
  return model;
}

// ---------------------------------------------------------------------------
// model -> iCal

function dateProp(ms, model, allDay = model.allDay) {
  if (allDay) {
    const z = utcToZoned(ms, model.tz);
    return { value: formatDate(z), params: { VALUE: "DATE" } };
  }
  if (model.tz == "UTC" || model.tz == "Etc/UTC") {
    return { value: formatUtc(ms), params: {} };
  }
  return { value: formatDateTime(utcToZoned(ms, model.tz)), params: { TZID: model.tz } };
}

function recurrenceToRRule(r, model) {
  const parts = [];
  const byday = d => {
    if (d == "Day") return "SU,MO,TU,WE,TH,FR,SA";
    if (d == "Weekday") return "MO,TU,WE,TH,FR";
    if (d == "WeekendDay") return "SA,SU";
    return ICAL_DAYS[DAYS.indexOf(d)];
  };
  const pos = idx => (idx == "Last" ? -1 : INDEX.indexOf(idx) + 1);
  switch (r.freq) {
    case "daily":
      parts.push("FREQ=DAILY");
      break;
    case "weekly":
      parts.push("FREQ=WEEKLY");
      if (r.days?.length) {
        parts.push(`BYDAY=${r.days.map(byday).join(",")}`);
      }
      if (r.firstDay) {
        parts.push(`WKST=${ICAL_DAYS[DAYS.indexOf(r.firstDay)]}`);
      }
      break;
    case "absMonthly":
      parts.push("FREQ=MONTHLY", `BYMONTHDAY=${r.dayOfMonth}`);
      break;
    case "relMonthly":
    case "relYearly": {
      parts.push(r.freq == "relMonthly" ? "FREQ=MONTHLY" : "FREQ=YEARLY");
      const d = r.days[0];
      if (d == "Day") {
        parts.push(`BYMONTHDAY=${pos(r.index) == -1 ? -1 : pos(r.index)}`);
      } else if (d == "Weekday" || d == "WeekendDay") {
        parts.push(`BYDAY=${byday(d)}`, `BYSETPOS=${pos(r.index)}`);
      } else {
        parts.push(`BYDAY=${pos(r.index)}${byday(d)}`);
      }
      if (r.freq == "relYearly") {
        parts.push(`BYMONTH=${MONTHS.indexOf(r.month) + 1}`);
      }
      break;
    }
    case "absYearly":
      parts.push("FREQ=YEARLY", `BYMONTH=${MONTHS.indexOf(r.month) + 1}`, `BYMONTHDAY=${r.dayOfMonth}`);
      break;
  }
  if (r.interval > 1) {
    parts.push(`INTERVAL=${r.interval}`);
  }
  if (r.range.type == "numbered") {
    parts.push(`COUNT=${r.range.count}`);
  } else if (r.range.type == "endDate" && r.range.endDate) {
    const [y, m, d] = r.range.endDate.split("-").map(Number);
    if (model.allDay) {
      parts.push(`UNTIL=${formatDate({ y, m, d })}`);
    } else {
      parts.push(`UNTIL=${formatUtc(zonedToUtc({ y, m, d, h: 23, mi: 59, s: 59 }, model.tz))}`);
    }
  }
  return parts.join(";");
}

function addAttendees(ev, model, ownEmail) {
  const own = (ownEmail || "").toLowerCase();
  const add = (list, role, cutype = null) => {
    for (const a of list) {
      if (!a.email) {
        continue;
      }
      let resp = a.response;
      if (own && a.email.toLowerCase() == own && model.myResponse && model.myResponse != "Organizer") {
        resp = model.myResponse;
      }
      const params = { ROLE: role, PARTSTAT: PARTSTAT[resp] || "NEEDS-ACTION" };
      if (a.name) {
        params.CN = a.name;
      }
      if (cutype) {
        params.CUTYPE = cutype;
      }
      if (params.PARTSTAT == "NEEDS-ACTION") {
        params.RSVP = "TRUE";
      }
      ev.add("ATTENDEE", `mailto:${a.email}`, params);
    }
  };
  add(model.required, "REQ-PARTICIPANT");
  add(model.optional, "OPT-PARTICIPANT");
  add(model.resources, "NON-PARTICIPANT", "RESOURCE");
}

function modelToVevent(model, { ownEmail, recurrenceId = null, now = Date.now() } = {}) {
  const ev = new Component("VEVENT");
  ev.add("UID", model.uid);
  ev.add("DTSTAMP", formatUtc(model.modified || now));
  if (recurrenceId !== null) {
    const p = dateProp(recurrenceId, model);
    ev.add("RECURRENCE-ID", p.value, p.params);
  }
  const s = dateProp(model.start, model);
  ev.add("DTSTART", s.value, s.params);
  let end = model.end;
  if (model.allDay && end <= model.start) {
    end = model.start + 86400000;
  }
  const e = dateProp(end, model);
  ev.add("DTEND", e.value, e.params);
  ev.add("SUMMARY", escapeText(model.subject || ""));
  if (model.location) {
    ev.add("LOCATION", escapeText(model.location));
  }
  if (model.body) {
    ev.add("DESCRIPTION", escapeText(model.body.replace(/\r\n/g, "\n").replace(/\s+$/, "")));
  }
  if (model.categories?.length) {
    ev.add("CATEGORIES", model.categories.map(escapeText).join(","));
  }
  if (model.sensitivity == "Private" || model.sensitivity == "Personal") {
    ev.add("CLASS", "PRIVATE");
  } else if (model.sensitivity == "Confidential") {
    ev.add("CLASS", "CONFIDENTIAL");
  }
  ev.add("TRANSP", model.busy == "Free" ? "TRANSPARENT" : "OPAQUE");
  ev.add("X-MICROSOFT-CDO-BUSYSTATUS", { Free: "FREE", Tentative: "TENTATIVE", OOF: "OOF", WorkingElsewhere: "WORKINGELSEWHERE" }[model.busy] || "BUSY");
  if (model.cancelled) {
    ev.add("STATUS", "CANCELLED");
  } else if (model.busy == "Tentative") {
    ev.add("STATUS", "TENTATIVE");
  } else {
    ev.add("STATUS", "CONFIRMED");
  }
  if (model.importance == "High") {
    ev.add("PRIORITY", "1");
  } else if (model.importance == "Low") {
    ev.add("PRIORITY", "9");
  }
  ev.add("SEQUENCE", String(model.sequence || 0));
  if (model.created) {
    ev.add("CREATED", formatUtc(model.created));
  }
  if (model.modified) {
    ev.add("LAST-MODIFIED", formatUtc(model.modified));
  }
  const hasAttendees = model.required.length || model.optional.length || model.resources.length;
  if (model.organizer?.email && (model.isMeeting || hasAttendees)) {
    const params = model.organizer.name ? { CN: model.organizer.name } : {};
    ev.add("ORGANIZER", `mailto:${model.organizer.email}`, params);
  }
  addAttendees(ev, model, ownEmail);
  if (recurrenceId === null && model.recurrence) {
    ev.add("RRULE", recurrenceToRRule(model.recurrence, model));
    for (const d of model.deleted || []) {
      const p = dateProp(d, model);
      ev.add("EXDATE", p.value, p.params);
    }
  }
  if (model.reminder !== null && model.reminder !== undefined) {
    const alarm = new Component("VALARM");
    alarm.add("ACTION", "DISPLAY");
    alarm.add("DESCRIPTION", "Reminder");
    alarm.add("TRIGGER", formatDuration(-model.reminder * 60), { RELATED: "START" });
    ev.components.push(alarm);
  }
  return ev;
}

/** Model (master with exceptions) -> VCALENDAR text. */
export function modelToIcal(model, opts = {}) {
  const cal = new Component("VCALENDAR");
  cal.add("VERSION", "2.0");
  cal.add("PRODID", "-//EWS Bridge//EN");
  cal.components.push(modelToVevent(model, opts));
  for (const ex of model.exceptions || []) {
    const m = { ...model, ...ex, uid: model.uid, recurrence: null, exceptions: [] };
    cal.components.push(modelToVevent(m, { ...opts, recurrenceId: ex.originalStart }));
  }
  return cal;
}

// ---------------------------------------------------------------------------
// iCal -> model

function resolveDate(prop, defaultTz) {
  if (!prop) {
    return null;
  }
  const v = parseDateValue(prop.value, prop.params);
  if (!v) {
    throw new ConversionError(`Bad date value ${prop.value}`);
  }
  if (v.date) {
    return { ms: Date.UTC(v.y, v.m - 1, v.d), date: true, fields: v, tz: null };
  }
  if (v.utc) {
    return { ms: Date.UTC(v.y, v.m - 1, v.d, v.h, v.mi, v.s), date: false, fields: v, tz: "UTC" };
  }
  const tz = toIana(v.tzid, defaultTz);
  return { ms: zonedToUtc(v, tz), date: false, fields: v, tz };
}

function parseRRule(value, startInfo, model) {
  const r = Object.fromEntries(value.split(";").map(p => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
  const interval = parseInt(r.INTERVAL || "1", 10);
  const startLocal = startInfo.date ? startInfo.fields : utcToZoned(model.start, model.tz);
  const weekdayOfStart = new Date(Date.UTC(startLocal.y, startLocal.m - 1, startLocal.d)).getUTCDay();
  const byday = r.BYDAY ? r.BYDAY.split(",").map(x => /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim())).filter(Boolean) : [];
  const setpos = r.BYSETPOS !== undefined ? parseInt(r.BYSETPOS, 10) : null;
  const monthdays = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : [];
  const months = r.BYMONTH ? r.BYMONTH.split(",").map(Number) : [];
  const unsupported = why => {
    throw new ConversionError(`Exchange cannot store this recurrence (${why}): ${value}`);
  };
  if (months.length > 1 || monthdays.length > 1 || r.BYHOUR || r.BYMINUTE || r.BYWEEKNO || r.BYYEARDAY) {
    unsupported("multiple months/days or sub-daily rules");
  }
  const dayName = code => DAYS[ICAL_DAYS.indexOf(code)];
  const indexName = n => {
    if (n == -1) return "Last";
    if (n >= 1 && n <= 4) return INDEX[n - 1];
    unsupported(`position ${n}`);
  };
  const specialDays = () => {
    const codes = byday.map(b => b[2]).sort().join(",");
    if (codes == "FR,MO,TH,TU,WE") return "Weekday";
    if (codes == "SA,SU") return "WeekendDay";
    if (codes == "FR,MO,SA,SU,TH,TU,WE") return "Day";
    return null;
  };
  const rec = { interval };
  switch ((r.FREQ || "").toUpperCase()) {
    case "DAILY":
      if (byday.length && specialDays() == "Weekday" && interval == 1) {
        Object.assign(rec, { freq: "weekly", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] });
      } else if (byday.length) {
        unsupported("daily with day filter");
      } else {
        rec.freq = "daily";
      }
      break;
    case "WEEKLY":
      rec.freq = "weekly";
      if (byday.some(b => b[1])) {
        unsupported("weekly with ordinal days");
      }
      rec.days = byday.length ? byday.map(b => dayName(b[2])) : [DAYS[weekdayOfStart]];
      rec.firstDay = r.WKST ? dayName(r.WKST) : "Monday";
      break;
    case "MONTHLY":
    case "YEARLY": {
      const yearly = r.FREQ.toUpperCase() == "YEARLY";
      if (yearly && interval != 1) {
        unsupported("yearly interval");
      }
      const month = MONTHS[(months[0] || startLocal.m) - 1];
      if (byday.length) {
        const special = specialDays();
        if (special && setpos !== null) {
          Object.assign(rec, { freq: yearly ? "relYearly" : "relMonthly", days: [special], index: indexName(setpos) });
        } else if (byday.length == 1 && (byday[0][1] || setpos !== null)) {
          Object.assign(rec, { freq: yearly ? "relYearly" : "relMonthly", days: [dayName(byday[0][2])], index: indexName(parseInt(byday[0][1] ?? setpos, 10)) });
        } else {
          unsupported("combination of days");
        }
      } else if (monthdays[0] == -1) {
        Object.assign(rec, { freq: yearly ? "relYearly" : "relMonthly", days: ["Day"], index: "Last" });
      } else {
        const dom = monthdays[0] || startLocal.d;
        if (dom < 1) {
          unsupported("negative month day");
        }
        Object.assign(rec, { freq: yearly ? "absYearly" : "absMonthly", dayOfMonth: dom });
      }
      if (yearly) {
        rec.month = month;
        rec.interval = 1;
      }
      break;
    }
    default:
      unsupported("frequency");
  }
  const startDate = `${startLocal.y}-${String(startLocal.m).padStart(2, "0")}-${String(startLocal.d).padStart(2, "0")}`;
  rec.range = { type: "noEnd", startDate };
  if (r.COUNT) {
    rec.range = { type: "numbered", startDate, count: parseInt(r.COUNT, 10) };
  } else if (r.UNTIL) {
    const u = parseDateValue(r.UNTIL);
    let local;
    if (u.date) {
      local = u;
    } else if (u.utc) {
      local = utcToZoned(Date.UTC(u.y, u.m - 1, u.d, u.h, u.mi, u.s), startInfo.date ? "UTC" : model.tz);
    } else {
      local = u;
    }
    rec.range = { type: "endDate", startDate, endDate: `${local.y}-${String(local.m).padStart(2, "0")}-${String(local.d).padStart(2, "0")}` };
  }
  return rec;
}

function parseCalAddress(v) {
  return String(v || "").replace(/^mailto:/i, "").trim();
}

function veventToModel(ev, defaultTz) {
  const s = resolveDate(ev.get("DTSTART"), defaultTz);
  if (!s) {
    throw new ConversionError("Event has no DTSTART");
  }
  const model = {
    uid: ev.value("UID"),
    subject: unescapeText(ev.value("SUMMARY", "")),
    body: ev.get("DESCRIPTION") ? unescapeText(ev.value("DESCRIPTION")) : null,
    location: ev.get("LOCATION") ? unescapeText(ev.value("LOCATION")) : null,
    allDay: s.date,
    tz: s.date ? defaultTz : s.tz,
    categories: ev.getAll("CATEGORIES").flatMap(p => splitList(p.value).map(unescapeText)).filter(Boolean),
    sensitivity: { PRIVATE: "Private", CONFIDENTIAL: "Confidential" }[(ev.value("CLASS") || "").toUpperCase()] || "Normal",
    importance: (() => {
      const p = parseInt(ev.value("PRIORITY") || "0", 10);
      return p >= 1 && p <= 4 ? "High" : p >= 6 ? "Low" : "Normal";
    })(),
    reminder: null,
    required: [],
    optional: [],
    resources: [],
    organizer: null,
    myResponse: null,
    cancelled: (ev.value("STATUS") || "").toUpperCase() == "CANCELLED",
    sequence: parseInt(ev.value("SEQUENCE") || "0", 10) || 0,
    recurrence: null,
    deleted: [],
    exceptions: [],
  };
  const cdo = (ev.value("X-MICROSOFT-CDO-BUSYSTATUS") || "").toUpperCase();
  const transp = (ev.value("TRANSP") || "OPAQUE").toUpperCase();
  model.busy = transp == "TRANSPARENT" ? "Free" : { TENTATIVE: "Tentative", OOF: "OOF", WORKINGELSEWHERE: "WorkingElsewhere", FREE: "Busy" }[cdo] || ((ev.value("STATUS") || "").toUpperCase() == "TENTATIVE" ? "Tentative" : "Busy");
  if (s.date) {
    model.start = zonedToUtc({ ...s.fields, h: 0, mi: 0, s: 0 }, model.tz);
  } else {
    model.start = s.ms;
  }
  const endProp = ev.get("DTEND");
  if (endProp) {
    const e = resolveDate(endProp, model.tz);
    model.end = e.date ? zonedToUtc({ ...e.fields, h: 0, mi: 0, s: 0 }, model.tz) : e.ms;
  } else if (ev.get("DURATION")) {
    model.end = model.start + (parseDuration(ev.value("DURATION")) || 0) * 1000;
  } else {
    model.end = s.date ? model.start + 86400000 : model.start;
  }
  for (const alarm of ev.sub("VALARM")) {
    const trig = alarm.get("TRIGGER");
    if (!trig || trig.params.VALUE == "DATE-TIME") {
      continue;
    }
    const secs = parseDuration(trig.value);
    if (secs === null) {
      continue;
    }
    const related = (trig.params.RELATED || "START").toUpperCase();
    let minutes = -secs / 60;
    if (related == "END") {
      minutes += (model.end - model.start) / 60000;
    }
    model.reminder = Math.max(0, Math.round(minutes));
    break;
  }
  const org = ev.get("ORGANIZER");
  if (org) {
    model.organizer = { name: org.params.CN || "", email: parseCalAddress(org.value) };
  }
  for (const a of ev.getAll("ATTENDEE")) {
    const entry = { name: a.params.CN || "", email: parseCalAddress(a.value), response: RESPONSE_FROM_PARTSTAT[(a.params.PARTSTAT || "NEEDS-ACTION").toUpperCase()] || "NoResponseReceived" };
    if (!entry.email) {
      continue;
    }
    const role = (a.params.ROLE || "REQ-PARTICIPANT").toUpperCase();
    const cutype = (a.params.CUTYPE || "").toUpperCase();
    if (cutype == "RESOURCE" || cutype == "ROOM" || role == "NON-PARTICIPANT") {
      model.resources.push(entry);
    } else if (role == "OPT-PARTICIPANT") {
      model.optional.push(entry);
    } else {
      model.required.push(entry);
    }
  }
  const rrule = ev.get("RRULE");
  if (rrule) {
    model.recurrence = parseRRule(rrule.value, s, model);
  }
  for (const ex of ev.getAll("EXDATE")) {
    for (const v of splitList(ex.value)) {
      const d = resolveDate({ value: v, params: ex.params }, model.tz);
      model.deleted.push(d.date ? zonedToUtc({ ...d.fields, h: utcToZoned(model.start, model.tz).h, mi: utcToZoned(model.start, model.tz).mi }, model.tz) : d.ms);
    }
  }
  return model;
}

/** Parse a VCALENDAR (master + exceptions) into a model. */
export function icalToModel(cal, { defaultTz = "UTC" } = {}) {
  const events = cal.sub("VEVENT");
  if (!events.length) {
    throw new ConversionError("No VEVENT in calendar object");
  }
  const master = events.find(e => !e.get("RECURRENCE-ID")) || null;
  const model = master ? veventToModel(master, defaultTz) : null;
  const exceptions = [];
  for (const ev of events) {
    const rid = ev.get("RECURRENCE-ID");
    if (!rid) {
      continue;
    }
    const tz = model?.tz || defaultTz;
    const r = resolveDate(rid, tz);
    const originalStart = r.date ? zonedToUtc({ ...r.fields, h: 0, mi: 0, s: 0 }, tz) : r.ms;
    exceptions.push({ originalStart, ...veventToModel(ev, tz) });
  }
  if (!model) {
    // Only exceptions (an invitation to a single occurrence) — treat first as the event.
    const first = exceptions.shift();
    return { ...first, exceptions: [] };
  }
  model.exceptions = exceptions;
  return model;
}

// ---------------------------------------------------------------------------
// model -> EWS XML

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function recurrenceXml(r) {
  let pattern;
  const iv = `<t:Interval>${r.interval || 1}</t:Interval>`;
  switch (r.freq) {
    case "daily":
      pattern = `<t:DailyRecurrence>${iv}</t:DailyRecurrence>`;
      break;
    case "weekly":
      pattern = `<t:WeeklyRecurrence>${iv}<t:DaysOfWeek>${r.days.join(" ")}</t:DaysOfWeek>${r.firstDay ? `<t:FirstDayOfWeek>${r.firstDay}</t:FirstDayOfWeek>` : ""}</t:WeeklyRecurrence>`;
      break;
    case "absMonthly":
      pattern = `<t:AbsoluteMonthlyRecurrence>${iv}<t:DayOfMonth>${r.dayOfMonth}</t:DayOfMonth></t:AbsoluteMonthlyRecurrence>`;
      break;
    case "relMonthly":
      pattern = `<t:RelativeMonthlyRecurrence>${iv}<t:DaysOfWeek>${r.days[0]}</t:DaysOfWeek><t:DayOfWeekIndex>${r.index}</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>`;
      break;
    case "absYearly":
      pattern = `<t:AbsoluteYearlyRecurrence><t:DayOfMonth>${r.dayOfMonth}</t:DayOfMonth><t:Month>${r.month}</t:Month></t:AbsoluteYearlyRecurrence>`;
      break;
    case "relYearly":
      pattern = `<t:RelativeYearlyRecurrence><t:DaysOfWeek>${r.days[0]}</t:DaysOfWeek><t:DayOfWeekIndex>${r.index}</t:DayOfWeekIndex><t:Month>${r.month}</t:Month></t:RelativeYearlyRecurrence>`;
      break;
    default:
      throw new ConversionError(`Unknown recurrence ${r.freq}`);
  }
  let range;
  const sd = `<t:StartDate>${r.range.startDate}</t:StartDate>`;
  if (r.range.type == "numbered") {
    range = `<t:NumberedRecurrence>${sd}<t:NumberOfOccurrences>${r.range.count}</t:NumberOfOccurrences></t:NumberedRecurrence>`;
  } else if (r.range.type == "endDate") {
    range = `<t:EndDateRecurrence>${sd}<t:EndDate>${r.range.endDate}</t:EndDate></t:EndDateRecurrence>`;
  } else {
    range = `<t:NoEndRecurrence>${sd}</t:NoEndRecurrence>`;
  }
  return `<t:Recurrence>${pattern}${range}</t:Recurrence>`;
}

function attendeeListXml(list) {
  return list
    .map(a => `<t:Attendee><t:Mailbox>${a.name ? textTag("t:Name", a.name) : ""}${textTag("t:EmailAddress", a.email)}</t:Mailbox></t:Attendee>`)
    .join("");
}

/** Fields of a model as EWS XML fragments keyed by FieldURI (schema-ordered). */
function fieldFragments(model) {
  const winTz = toWindows(model.tz) || "UTC";
  const f = [];
  f.push(["item:Subject", textTag("t:Subject", model.subject || "")]);
  f.push(["item:Sensitivity", textTag("t:Sensitivity", model.sensitivity || "Normal")]);
  f.push(["item:Body", model.body !== null && model.body !== undefined ? textTag("t:Body", model.body, { BodyType: "Text" }) : null]);
  f.push(["item:Categories", model.categories?.length ? `<t:Categories>${model.categories.map(c => textTag("t:String", c)).join("")}</t:Categories>` : null]);
  f.push(["item:Importance", textTag("t:Importance", model.importance || "Normal")]);
  f.push(["item:ReminderIsSet", textTag("t:ReminderIsSet", model.reminder !== null && model.reminder !== undefined ? "true" : "false")]);
  f.push(["item:ReminderMinutesBeforeStart", model.reminder !== null && model.reminder !== undefined ? textTag("t:ReminderMinutesBeforeStart", String(model.reminder)) : null]);
  f.push(["calendar:Start", textTag("t:Start", isoUtc(model.start))]);
  f.push(["calendar:End", textTag("t:End", isoUtc(model.end))]);
  f.push(["calendar:IsAllDayEvent", textTag("t:IsAllDayEvent", model.allDay ? "true" : "false")]);
  f.push(["calendar:LegacyFreeBusyStatus", textTag("t:LegacyFreeBusyStatus", model.busy || "Busy")]);
  f.push(["calendar:Location", model.location ? textTag("t:Location", model.location) : null]);
  f.push(["calendar:RequiredAttendees", model.required?.length ? `<t:RequiredAttendees>${attendeeListXml(model.required)}</t:RequiredAttendees>` : null]);
  f.push(["calendar:OptionalAttendees", model.optional?.length ? `<t:OptionalAttendees>${attendeeListXml(model.optional)}</t:OptionalAttendees>` : null]);
  f.push(["calendar:Resources", model.resources?.length ? `<t:Resources>${attendeeListXml(model.resources)}</t:Resources>` : null]);
  f.push(["calendar:Recurrence", model.recurrence ? recurrenceXml(model.recurrence) : null]);
  f.push(["calendar:StartTimeZone", `<t:StartTimeZone Id="${xmlEscape(winTz)}"/>`]);
  f.push(["calendar:EndTimeZone", `<t:EndTimeZone Id="${xmlEscape(winTz)}"/>`]);
  return f;
}

/** <t:CalendarItem> for CreateItem. */
export function modelToCreateXml(model, { withUid = true } = {}) {
  const frags = fieldFragments(model).filter(([, x]) => x);
  // UID sits between the Item fields and Start in the schema.
  const idx = frags.findIndex(([k]) => k == "calendar:Start");
  const itemPart = frags.slice(0, idx).map(([, x]) => x).join("");
  const calPart = frags.slice(idx).map(([, x]) => x).join("");
  return `<t:CalendarItem>${itemPart}${withUid && model.uid ? textTag("t:UID", model.uid) : ""}${calPart}</t:CalendarItem>`;
}

const SIGNIFICANT = new Set(["calendar:Start", "calendar:End", "calendar:IsAllDayEvent", "calendar:Location", "item:Subject", "item:Body", "calendar:Recurrence", "calendar:RequiredAttendees", "calendar:OptionalAttendees", "calendar:Resources"]);

/**
 * Differences between two models as UpdateItem operations.
 * Returns { set: [xml], del: [xml], significant: bool, fields: [uri] }
 */
export function diffModels(oldM, newM, { kind = "CalendarItem" } = {}) {
  const a = new Map(fieldFragments(oldM));
  const b = fieldFragments(newM);
  const set = [];
  const del = [];
  const fields = [];
  let significant = false;
  let timesChanged = false;
  for (const [uri, xml] of b) {
    const before = a.get(uri);
    if (uri == "calendar:StartTimeZone" || uri == "calendar:EndTimeZone") {
      continue; // handled with times below
    }
    if (ATTENDEE_URIS[uri]) {
      if (emailSet(oldM[ATTENDEE_URIS[uri]]) == emailSet(newM[ATTENDEE_URIS[uri]])) {
        continue;
      }
    } else if (normalizeFragment(before) == normalizeFragment(xml)) {
      continue;
    }
    fields.push(uri);
    if (SIGNIFICANT.has(uri)) {
      significant = true;
    }
    if (uri == "calendar:Start" || uri == "calendar:End" || uri == "calendar:IsAllDayEvent" || uri == "calendar:Recurrence") {
      timesChanged = true;
    }
    if (xml) {
      set.push(`<t:FieldURI FieldURI="${uri}"/><t:${kind}>${xml}</t:${kind}>`);
    } else if (before) {
      del.push(`<t:FieldURI FieldURI="${uri}"/>`);
    }
  }
  if (timesChanged || oldM.tz != newM.tz) {
    const tzXml = fieldFragments(newM).filter(([k]) => k.endsWith("TimeZone"));
    for (const [uri, xml] of tzXml) {
      set.push(`<t:FieldURI FieldURI="${uri}"/><t:${kind}>${xml}</t:${kind}>`);
    }
  }
  // Exchange expects Start/End after time zones are set in the same request order-insensitively,
  // but some versions validate End > Start per SetItemField: send times last.
  set.sort((x, y) => timeRank(x) - timeRank(y));
  return { set, del, significant, fields };
}

const ATTENDEE_URIS = { "calendar:RequiredAttendees": "required", "calendar:OptionalAttendees": "optional", "calendar:Resources": "resources" };

function emailSet(list) {
  return (list || []).map(a => a.email.toLowerCase()).sort().join(",");
}

/** Remove the organizer (and optionally the user) from attendee lists. */
export function withoutSelf(model, emails) {
  const skip = new Set(emails.filter(Boolean).map(e => e.toLowerCase()));
  const f = list => (list || []).filter(a => !skip.has(a.email.toLowerCase()));
  return { ...model, required: f(model.required), optional: f(model.optional), resources: f(model.resources) };
}

/** Find the PARTSTAT the model assigns to `email` (as EWS response type). */
export function responseOf(model, email) {
  const e = (email || "").toLowerCase();
  for (const a of [...(model.required || []), ...(model.optional || []), ...(model.resources || [])]) {
    if (a.email.toLowerCase() == e) {
      return a.response;
    }
  }
  return null;
}

function timeRank(x) {
  if (x.includes('"calendar:StartTimeZone"') || x.includes('"calendar:EndTimeZone"')) return 0;
  if (x.includes('"calendar:Start"')) return 2;
  if (x.includes('"calendar:End"')) return 3;
  return 1;
}

function normalizeFragment(x) {
  return (x || "").replace(/\r\n/g, "\n").replace(/\s+<\/t:Body>/, "</t:Body>");
}

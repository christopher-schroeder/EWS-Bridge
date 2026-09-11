/* EWS Bridge — time zones.
 * Exchange identifies zones by Windows IDs ("W. Europe Standard Time");
 * Thunderbird uses IANA IDs ("Europe/Berlin"). Mapping follows CLDR
 * windowsZones (territory 001 = primary zone). Conversions use Intl, which
 * carries the full tz database in both Gecko and Deno.
 */

export const WINDOWS_TO_IANA = {
  "Dateline Standard Time": "Etc/GMT+12",
  "UTC-11": "Etc/GMT+11",
  "Aleutian Standard Time": "America/Adak",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Marquesas Standard Time": "Pacific/Marquesas",
  "Alaskan Standard Time": "America/Anchorage",
  "UTC-09": "Etc/GMT+9",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "UTC-08": "Etc/GMT+8",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Mountain Standard Time": "America/Denver",
  "Yukon Standard Time": "America/Whitehorse",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Easter Island Standard Time": "Pacific/Easter",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "Eastern Standard Time": "America/New_York",
  "Haiti Standard Time": "America/Port-au-Prince",
  "Cuba Standard Time": "America/Havana",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "Turks And Caicos Standard Time": "America/Grand_Turk",
  "Paraguay Standard Time": "America/Asuncion",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "Central Brazilian Standard Time": "America/Cuiaba",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "Tocantins Standard Time": "America/Araguaina",
  "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Greenland Standard Time": "America/Nuuk",
  "Montevideo Standard Time": "America/Montevideo",
  "Magallanes Standard Time": "America/Punta_Arenas",
  "Saint Pierre Standard Time": "America/Miquelon",
  "Bahia Standard Time": "America/Bahia",
  "UTC-02": "Etc/GMT+2",
  "Mid-Atlantic Standard Time": "Etc/GMT+2",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Sao Tome Standard Time": "Africa/Sao_Tome",
  "Morocco Standard Time": "Africa/Casablanca",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "Jordan Standard Time": "Asia/Amman",
  "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Syria Standard Time": "Asia/Damascus",
  "West Bank Standard Time": "Asia/Hebron",
  "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kyiv",
  "Israel Standard Time": "Asia/Jerusalem",
  "South Sudan Standard Time": "Africa/Juba",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "Sudan Standard Time": "Africa/Khartoum",
  "Libya Standard Time": "Africa/Tripoli",
  "Namibia Standard Time": "Africa/Windhoek",
  "Arabic Standard Time": "Asia/Baghdad",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Belarus Standard Time": "Europe/Minsk",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Volgograd Standard Time": "Europe/Volgograd",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Astrakhan Standard Time": "Europe/Astrakhan",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Russia Time Zone 3": "Europe/Samara",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Saratov Standard Time": "Europe/Saratov",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Afghanistan Standard Time": "Asia/Kabul",
  "West Asia Standard Time": "Asia/Tashkent",
  "Qyzylorda Standard Time": "Asia/Qyzylorda",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Kolkata",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Central Asia Standard Time": "Asia/Almaty",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Omsk Standard Time": "Asia/Omsk",
  "Myanmar Standard Time": "Asia/Yangon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Altai Standard Time": "Asia/Barnaul",
  "W. Mongolia Standard Time": "Asia/Hovd",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Tomsk Standard Time": "Asia/Tomsk",
  "China Standard Time": "Asia/Shanghai",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "Taipei Standard Time": "Asia/Taipei",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Aus Central W. Standard Time": "Australia/Eucla",
  "Transbaikal Standard Time": "Asia/Chita",
  "Tokyo Standard Time": "Asia/Tokyo",
  "North Korea Standard Time": "Asia/Pyongyang",
  "Korea Standard Time": "Asia/Seoul",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Bougainville Standard Time": "Pacific/Bougainville",
  "Russia Time Zone 10": "Asia/Srednekolymsk",
  "Magadan Standard Time": "Asia/Magadan",
  "Norfolk Standard Time": "Pacific/Norfolk",
  "Sakhalin Standard Time": "Asia/Sakhalin",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "Russia Time Zone 11": "Asia/Kamchatka",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC+12": "Etc/GMT-12",
  "Fiji Standard Time": "Pacific/Fiji",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  "UTC+13": "Etc/GMT-13",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
  "Line Islands Standard Time": "Pacific/Kiritimati",
};

// Additional IANA zones and legacy aliases that share a Windows zone.
const EXTRA_IANA_TO_WINDOWS = {
  "W. Europe Standard Time": ["Europe/Amsterdam", "Europe/Vienna", "Europe/Rome", "Europe/Stockholm", "Europe/Zurich", "Europe/Oslo", "Europe/Luxembourg", "Europe/Monaco", "Europe/Malta", "Europe/Andorra", "Europe/Vaduz", "Europe/San_Marino", "Europe/Vatican", "Europe/Gibraltar", "Europe/Busingen", "Arctic/Longyearbyen"],
  "Romance Standard Time": ["Europe/Brussels", "Europe/Copenhagen", "Europe/Madrid", "Africa/Ceuta"],
  "Central Europe Standard Time": ["Europe/Prague", "Europe/Bratislava", "Europe/Ljubljana", "Europe/Belgrade", "Europe/Tirane", "Europe/Podgorica"],
  "Central European Standard Time": ["Europe/Sarajevo", "Europe/Skopje", "Europe/Zagreb"],
  "GMT Standard Time": ["Europe/Dublin", "Europe/Lisbon", "Atlantic/Canary", "Atlantic/Faeroe", "Atlantic/Faroe", "Atlantic/Madeira", "Europe/Guernsey", "Europe/Isle_of_Man", "Europe/Jersey"],
  "FLE Standard Time": ["Europe/Kiev", "Europe/Helsinki", "Europe/Riga", "Europe/Tallinn", "Europe/Vilnius", "Europe/Sofia", "Europe/Mariehamn", "Europe/Uzhgorod", "Europe/Zaporozhye"],
  "GTB Standard Time": ["Europe/Athens", "Asia/Nicosia", "Asia/Famagusta"],
  "Eastern Standard Time": ["America/Toronto", "America/Detroit", "America/Nassau", "America/Montreal", "America/Kentucky/Louisville", "US/Eastern", "EST5EDT"],
  "Central Standard Time": ["America/Winnipeg", "US/Central", "CST6CDT"],
  "Mountain Standard Time": ["America/Edmonton", "America/Boise", "US/Mountain", "MST7MDT"],
  "Pacific Standard Time": ["America/Vancouver", "US/Pacific", "PST8PDT"],
  "India Standard Time": ["Asia/Calcutta"],
  "China Standard Time": ["Asia/Hong_Kong", "Asia/Macau", "Asia/Chongqing", "Asia/Harbin", "PRC"],
  "Tokyo Standard Time": ["Japan"],
  "Nepal Standard Time": ["Asia/Katmandu"],
  "Myanmar Standard Time": ["Asia/Rangoon"],
  "Greenland Standard Time": ["America/Godthab"],
  "Argentina Standard Time": ["America/Buenos_Aires"],
  "US Eastern Standard Time": ["America/Indianapolis"],
  "UTC": ["Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Etc/Zulu", "Z"],
  "AUS Eastern Standard Time": ["Australia/Melbourne", "Australia/Canberra"],
  "Singapore Standard Time": ["Asia/Kuala_Lumpur", "Asia/Manila"],
  "SE Asia Standard Time": ["Asia/Jakarta", "Asia/Saigon", "Asia/Ho_Chi_Minh"],
  "Arabian Standard Time": ["Asia/Muscat"],
  "E. Africa Standard Time": ["Africa/Addis_Ababa", "Africa/Dar_es_Salaam", "Africa/Kampala"],
  "South Africa Standard Time": ["Africa/Harare", "Africa/Maputo"],
  "W. Central Africa Standard Time": ["Africa/Algiers", "Africa/Tunis", "Africa/Kinshasa"],
  "Greenwich Standard Time": ["Africa/Abidjan", "Africa/Accra", "Africa/Dakar"],
};

export const IANA_TO_WINDOWS = {};
for (const [win, iana] of Object.entries(WINDOWS_TO_IANA)) {
  if (!IANA_TO_WINDOWS[iana]) {
    IANA_TO_WINDOWS[iana] = win;
  }
}
for (const [win, list] of Object.entries(EXTRA_IANA_TO_WINDOWS)) {
  for (const iana of list) {
    IANA_TO_WINDOWS[iana] ??= win;
  }
}

/** Map any TZID (Windows or IANA, possibly Outlook-decorated) to IANA. */
export function toIana(tzid, fallback = "UTC") {
  if (!tzid) {
    return fallback;
  }
  tzid = String(tzid).replace(/^\//, "").trim();
  if (WINDOWS_TO_IANA[tzid]) {
    return WINDOWS_TO_IANA[tzid];
  }
  if (isValidZone(tzid)) {
    return tzid;
  }
  // Outlook exports sometimes wrap names: "(UTC+01:00) Amsterdam, Berlin, ..." or quote them.
  const unquoted = tzid.replace(/^"|"$/g, "");
  if (WINDOWS_TO_IANA[unquoted]) {
    return WINDOWS_TO_IANA[unquoted];
  }
  if (/Amsterdam|Berlin|Bern|Rome|Stockholm|Vienna/i.test(tzid)) {
    return "Europe/Berlin";
  }
  return fallback;
}

/** IANA -> Windows ID (null if there is no mapping). */
export function toWindows(iana) {
  if (!iana) {
    return null;
  }
  if (WINDOWS_TO_IANA[iana]) {
    return iana; // already a Windows ID
  }
  return IANA_TO_WINDOWS[iana] || IANA_TO_WINDOWS[canonicalZone(iana)] || null;
}

const zoneCache = new Map();

function formatter(tz) {
  let f = zoneCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneCache.set(tz, f);
  }
  return f;
}

export function isValidZone(tz) {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function canonicalZone(tz) {
  try {
    return formatter(tz).resolvedOptions().timeZone;
  } catch {
    return tz;
  }
}

/** Wall-clock fields of instant `ms` in zone `tz`. */
export function utcToZoned(ms, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type != "literal") {
      parts[p.type] = parseInt(p.value, 10);
    }
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}

function offsetAt(ms, tz) {
  const z = utcToZoned(ms, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant for wall-clock fields in zone `tz`. For times skipped by a DST
 * jump the later interpretation is used; for repeated times the earlier one.
 */
export function zonedToUtc({ y, m, d, h = 0, mi = 0, s = 0 }, tz) {
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = asUtc - offsetAt(asUtc, tz);
  const o2 = offsetAt(guess, tz);
  const candidate = asUtc - o2;
  if (candidate != guess) {
    // near a transition; pick the offset that reproduces the wall time
    const z = utcToZoned(candidate, tz);
    guess = z.h == h && z.mi == mi ? candidate : guess;
  }
  return guess;
}

/** The local system zone (platform default). */
export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

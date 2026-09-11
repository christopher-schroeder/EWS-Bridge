# EWS Bridge for Thunderbird

Use a Microsoft Exchange mailbox (via Exchange Web Services) in Thunderbird:
**mail, calendar, contacts and the global address list (GAL)**.

Written from scratch against Microsoft's public EWS documentation and
Thunderbird's MPL-licensed source. It contains no code from "Owl for
Exchange", which is proprietary.

## How it works

The add-on runs a small gateway **inside Thunderbird**, bound to 127.0.0.1
only. Thunderbird's own, mature clients talk to it with standard protocols,
and the gateway translates every request to EWS:

```
Thunderbird IMAP client    ──►  local IMAP   ─┐
Thunderbird SMTP client    ──►  local SMTP   ─┤  EWS Bridge  ──EWS/HTTPS──►  Exchange
Thunderbird CalDAV client  ──►  local CalDAV ─┤  (background page)
Thunderbird CardDAV client ──►  local CardDAV─┤
Address autocomplete       ──►  GAL provider ─┘
```

This means offline storage, search, filters, tags, reminders and invitations
all come from Thunderbird itself.

**Authentication** is done by Gecko's HTTP stack (`nsHttpNTLMAuth`,
Negotiate, Basic) using the stored credentials. That is a different code path
from Thunderbird's built-in EWS client, which has its own NTLM implementation.
The account setup tries several username forms and reports each attempt, so
failures are understandable. It also shows which auth schemes the server
offers.

## Install

1. Build the package: `./build.sh` → `dist/ews-bridge-0.9.0.xpi`.
2. In Thunderbird, open *Add-ons and Themes*, click ⚙ and choose
   *Install Add-on From File…*, then pick the `.xpi`.
3. The settings page opens. Enter your e-mail address and password, click
   **Connect**, then **Add to Thunderbird**.

For TU Dortmund (checked from outside: on-premises Exchange 2019, EWS at
`https://outlook.tu-dortmund.de/EWS/Exchange.asmx`, which offers Negotiate
and NTLM):

- Autodiscover should find the server. If it doesn't, open *Advanced* and
  enter that EWS URL.
- If the login is rejected with your e-mail address, enter your university
  account name under *Advanced → Username*, either as `DOMAIN\user` or as
  `user@domain`. The result list shows every attempt.

Once added, you get the following:

- An IMAP account `you@… (Exchange)` with all mail folders, including
  special-use folders (Sent, Drafts, Deleted Items, Junk) mapped to
  Thunderbird's roles.
- An SMTP server that sends through Exchange. Exchange stores the Sent copy,
  so Thunderbird's own copy is switched off to avoid duplicates.
- One calendar per Exchange calendar folder and one address book per contacts
  folder.
- A "Directory" address book that searches the GAL live (used for
  autocomplete).

Passwords are kept in Thunderbird's password manager. The local gateway
uses a random per-account token, not your Exchange password.

## What is supported

| Area | Details |
|---|---|
| Mail | Folder sync (incremental via `SyncFolderItems`), read / flagged / answered / forwarded, Exchange categories ↔ Thunderbird tags, move / copy / delete (soft delete, recoverable), drafts, create / rename / delete folders, server-side text search, IDLE-style push (polling), large messages, umlaut folder names |
| Sending | Via EWS `SendAndSaveCopy`; Bcc preserved; send-as errors reported in plain text |
| Calendar | Read/write; recurrence (daily / weekly / monthly / yearly, relative and absolute), exceptions and deleted occurrences, time zones (Windows ↔ IANA, DST-correct), reminders, busy status, categories; meetings: invitations, updates and cancellations are sent by Exchange; as attendee, accept / tentative / decline become real meeting responses |
| Contacts | Read/write personal contacts (names, 3 e-mails, phones, addresses, company, birthday, notes, categories) |
| GAL | Live search via `ResolveNames` for autocomplete |

## Limits

- **Not yet tested against a real Exchange server.** Everything is verified
  against a mock EWS server (see Tests). The code follows the EWS schema,
  including element order, but your server is the real test. If something
  fails, set the log level to *Debug* on the settings page and look at the
  log there.
- **NTLM with Extended Protection (channel binding).** If your server
  enforces EPA for NTLM and Gecko's NTLM module does not send channel
  bindings, the login fails with "rejected the login". Kerberos (Negotiate)
  can then work if you have a ticket (`kinit`). Choose *Kerberos* under
  *Advanced*.
- Only EWS is supported; the OWA and ActiveSync protocols are not. Exchange
  Online (Microsoft 365) is not a target: Microsoft is retiring EWS there.
- Not implemented: tasks, out-of-office settings, free/busy lookup when
  scheduling, shared or delegated mailboxes, public folders, contact photos,
  distribution lists.
- Message sizes shown before download are Exchange's item size (close to,
  but not exactly, the MIME size). Chunked fetching is disabled for the
  account so messages are never truncated.

## Development

```
core/          protocol code, platform-independent (runs in Deno and in Thunderbird)
  ews/         EWS client, SOAP, autodiscover
  imap/        IMAP server + Exchange-backed mailbox model (UID mapping, sync)
  smtp/        SMTP submission → EWS
  cal/         iCalendar, time zones, EWS ↔ VEVENT conversion, calendar collection
  contacts/    vCard ↔ EWS contact, address book collection, GAL
  dav/         HTTP/1.1 + WebDAV (CalDAV/CardDAV) server
  gateway.mjs  wires accounts to the local servers
platform/tb.mjs     Thunderbird adapter (sockets/HTTP via the experiment API)
experiments/bridge  privileged API: loopback sockets, Gecko HTTP auth,
                    password manager, creating Thunderbird accounts
background.js       startup, connection test, account management
ui/                 settings page
```

### Tests

```
deno test --allow-net tests/*.test.mjs      # 51 unit/integration tests (mock EWS)
tests/e2e/run.sh                            # real Thunderbird end to end
```

The end-to-end test starts a throwaway Thunderbird profile with the add-on
and a seeded mock Exchange, then drives Thunderbird's own mail, compose and
contacts APIs. It checks 23 things: setup, IMAP sync, bodies, flags, move,
sending with Bcc, GAL, CardDAV both directions, CalDAV, restart and removal.
Thunderbird only starts add-ons after its window has painted, so use an
off-screen compositor:

```
kwin_wayland --virtual --no-lockscreen --socket wl-e2e &
E2E_WAYLAND=wl-e2e tests/e2e/run.sh
```

Opt-in tracing of the socket layer: set the pref
`extensions.ewsbridge.debug` to `true` (output on stdout).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Christopher Schroeder.

Written from scratch; the add-on contains no code from Thunderbird, from
"Owl for Exchange" or from ExQuilla. The Windows-to-IANA time zone table in
`core/cal/tz.mjs` is derived from the Unicode CLDR `windowsZones` data,
Copyright (C) 1991-2024 Unicode, Inc., distributed under the
[Unicode Terms of Use](https://www.unicode.org/copyright.html).

Microsoft, Exchange and Outlook are trademarks of Microsoft Corporation.
This project is not affiliated with or endorsed by Microsoft or by MZLA
Technologies Corporation.

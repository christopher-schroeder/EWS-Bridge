/* End-to-end scenario, injected into a test copy of the extension.
 * Drives the real add-on through Thunderbird's own mail/compose/contacts
 * APIs and reports to the mock server. Never shipped. */

const cfg = await (await fetch(browser.runtime.getURL("e2e-config.json"))).json();
window.addEventListener("error", e => note(`page error: ${e.message} ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", e => note(`unhandled rejection: ${e.reason?.message || e.reason}`));
const results = {};
const log = [];
const t0 = Date.now();
const note = m => {
  const line = `${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`;
  log.push(line);
  fetch(`${cfg.base}/e2e/log`, { method: "POST", body: line }).catch(() => {});
};
const check = (name, ok, detail = null) => {
  results[name] = { ok: !!ok, detail };
  note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail == "string" ? detail : JSON.stringify(detail)}` : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = async msg => {
  for (let i = 0; i < 100 && !globalThis.ewsBridge; i++) {
    await sleep(100);
  }
  return globalThis.ewsBridge.handleMessage(msg);
};
async function waitFor(fn, ms, step = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) {
        return v;
      }
    } catch (e) {
      note(`waitFor: ${e.message}`);
    }
    if (Date.now() > end) {
      return null;
    }
    await sleep(step);
  }
}
const state = () => fetch(`${cfg.base}/e2e/state`).then(r => r.json());
const report = async done =>
  fetch(`${cfg.base}/e2e/report`, { method: "POST", body: JSON.stringify({ done, results, log, gatewayLog: (await send({ type: "getState" }).catch(() => ({ log: [] }))).log }) });

async function listAll(folderId) {
  let page = await browser.messages.list(folderId);
  const out = [...page.messages];
  while (page.id) {
    page = await browser.messages.continueList(page.id);
    out.push(...page.messages);
  }
  return out;
}

note("scenario started");
const phase = (await browser.storage.local.get("e2ePhase")).e2ePhase || 1;
try {
if (phase == 1) {
  const st = await waitFor(async () => {
    const s = await send({ type: "getState" });
    return s?.status?.ports?.imap ? s : null;
  }, 30000, 500);
  check("gateway started", st, st?.status?.ports);
  await send({ type: "setLogLevel", level: "debug" });

  // 1. Username that is not accepted → helpful failure
  const bad = await send({ type: "testConnection", params: { email: cfg.email, password: cfg.password, ewsUrl: cfg.ewsUrl } });
  check("wrong username is rejected with a hint", !bad.ok && /rejected the login/.test(bad.hint || ""), bad.hint);

  // 2. Correct DOMAIN\user login, Gecko performs the HTTP auth
  const good = await send({ type: "testConnection", params: { email: cfg.email, password: cfg.password, username: cfg.username, ewsUrl: cfg.ewsUrl } });
  check("connection test succeeds", good.ok, good.ok ? `${good.displayName} / Exchange ${good.serverVersion}` : good.attempts);
  if (!good.ok) {
    throw new Error("cannot continue");
  }

  // 3. Add the account (IMAP + SMTP + CalDAV + CardDAV in Thunderbird)
  const added = await send({ type: "addAccount", params: { email: cfg.email, password: cfg.password, username: good.username, ewsUrl: good.ewsUrl, displayName: good.displayName } });
  check("account added", !added.error, added.error || added.created);
  // Give the live kick-off a chance, then restart like a user would.
  const early = await waitFor(async () => {
    const a = (await browser.accounts.list()).find(x => x.identities?.some(i => i.email == cfg.email));
    const f = a && (await browser.folders.query({ accountId: a.id, specialUse: ["trash"] }));
    return f?.length ? f : null;
  }, 20000);
  check("folders discovered without restart", early);
  await browser.storage.local.set({ e2ePhase: 2, e2eResults: results, e2eLog: log });
  await report(false);
  await browser.e2eprobe.quit();
  await new Promise(() => {});
}
} catch (e) {
  note(`ERROR ${e.message}\n${e.stack}`);
  await report(true);
  await new Promise(() => {});
}

// ---- phase 2 (after restart) ----
Object.assign(results, (await browser.storage.local.get("e2eResults")).e2eResults || {});
log.unshift(...((await browser.storage.local.get("e2eLog")).e2eLog || []), "---- restarted ----");
try {
  {

  // 4. Thunderbird's IMAP client syncs the inbox through the gateway
  await waitFor(async () => (await send({ type: "getState" }))?.status?.ports?.imap, 30000, 500);
  const account = await waitFor(async () => (await browser.accounts.list()).find(a => a.identities?.some(i => i.email == cfg.email)), 20000);
  check("Thunderbird account exists", account, account && { type: account.type, name: account.name });
  const inbox = await waitFor(async () => (await browser.folders.query({ accountId: account.id, specialUse: ["inbox"] }))[0], 60000);
  check("INBOX discovered", inbox);
  const folders = await browser.folders.query({ accountId: account.id });
  check("special folders mapped", ["trash", "sent", "drafts", "junk"].every(u => folders.some(f => f.specialUse?.includes(u))), folders.map(f => `${f.name}[${(f.specialUse || []).join(",")}]`));
  const msgs = await waitFor(async () => {
    const m = await listAll(inbox.id);
    return m.length >= 3 ? m : null;
  }, 90000, 2000);
  check("inbox messages synced", msgs, msgs?.map(m => `${m.subject} read=${m.read} size=${m.size}`));
  if (!msgs) {
    throw new Error("no messages");
  }
  const klausur = msgs.find(m => m.subject == "Klausurtermine WiSe");
  const seminar = msgs.find(m => m.subject == "Seminar Anmeldung");
  const big = msgs.find(m => m.subject == "Großes Paket");
  check("umlaut subject and sender decoded", big && klausur?.author?.includes("Müller"), { author: klausur?.author, big: big?.subject });
  check("read state from Exchange", seminar?.read === true && klausur?.read === false);

  // 5. Body fetched through the gateway (BODY[] via EWS MimeContent)
  const full = await browser.messages.getFull(klausur.id);
  const text = JSON.stringify(full);
  check("message body downloaded", text.includes("Die Klausur findet am 12.02. statt."));
  const raw = await browser.messages.getRaw(big.id, { data_format: "BinaryString" }).catch(e => e.message);
  check("large message not truncated", typeof raw == "string" && raw.includes("x".repeat(199000)), typeof raw == "string" ? raw.length : raw);

  // 6. Flags go back to Exchange
  await browser.messages.update(klausur.id, { read: true, flagged: true });
  const flagged = await waitFor(async () => {
    const s = await state();
    const it = s.inbox.find(i => i.subject == "Klausurtermine WiSe");
    return it?.isRead && it?.flag == "2" ? it : null;
  }, 30000);
  check("read + flag written to Exchange", flagged, flagged);

  // 7. Move to trash → MoveItem
  const trash = folders.find(f => f.specialUse?.includes("trash"));
  await browser.messages.move([seminar.id], trash.id);
  const moved = await waitFor(async () => {
    const s = await state();
    return s.deleted.some(i => i.subject == "Seminar Anmeldung") && !s.inbox.some(i => i.subject == "Seminar Anmeldung") ? s : null;
  }, 30000);
  check("move to trash reaches Exchange", moved);

  // 8. Send mail through Thunderbird's SMTP client → gateway → EWS
  const identity = account.identities.find(i => i.email == cfg.email);
  const tab = await browser.compose.beginNew({ identityId: identity.id, to: ["clara.weber@example.org"], bcc: ["hidden@example.org"], subject: "E2E Grüße aus Thunderbird", plainTextBody: "Hallo Clara,\n.\nein Punkt allein auf einer Zeile.", isPlainText: true });
  await sleep(1500);
  const sent = await browser.compose.sendMessage(tab.id, { mode: "sendNow" }).catch(e => ({ error: e.message }));
  const delivered = await waitFor(async () => {
    const s = await state();
    return s.sent.find(x => x.mime && x.mime.includes("clara.weber@example.org")) || null;
  }, 45000);
  check("message sent through Exchange", delivered, sent?.error || null);
  check("Bcc recipient preserved", delivered?.mime.includes("hidden@example.org"));
  const sentCount = (await state()).sentItems.filter(i => i.subject.startsWith("E2E")).length;
  check("exactly one Sent copy (Exchange's, none uploaded by Thunderbird)", sentCount == 1, sentCount);

  // 9. Global Address List autocomplete (address book provider)
  const gal = await waitFor(async () => {
    const r = await browser.contacts.quickSearch({ searchString: "Weber", includeLocal: false, includeRemote: true });
    return r.length ? r : null;
  }, 20000);
  check("GAL search returns directory entries", gal?.some(c => JSON.stringify(c).includes("clara.weber@example.org")), gal?.map(c => c.properties?.DisplayName || c.vCard?.slice(0, 80)));

  // 10. CardDAV address book filled from Exchange contacts
  const books = await browser.addressBooks.list(true);
  const book = books.find(b => b.name.startsWith("Contacts"));
  const contacts = await waitFor(async () => {
    const b = (await browser.addressBooks.list(true)).find(x => x.id == book?.id);
    return b?.contacts?.length ? b.contacts : null;
  }, 60000, 2000);
  check("Exchange contacts in address book", contacts?.some(c => JSON.stringify(c).includes("bernd.schmidt@example.org")), contacts?.length);

  // 11. Create a contact in Thunderbird → CardDAV PUT → EWS CreateItem
  if (book) {
    await browser.contacts.create(book.id, null, { vCard: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Eva E2E\r\nN:E2E;Eva;;;\r\nEMAIL:eva@example.org\r\nEND:VCARD\r\n" });
    const created = await waitFor(async () => ((await state()).contacts.length >= 2 ? true : null), 60000, 2000);
    check("contact created in Thunderbird reaches Exchange", created);
  }

  // 12. Calendar: Thunderbird's CalDAV provider pulled the event (checked on disk by the harness)
  // 12. Calendar: Thunderbird's CalDAV provider cached the Exchange event
  const titles = await waitFor(async () => {
    const t = await browser.e2eprobe.calendarTitles();
    return t.includes("Vorlesung Datenbanken") ? t : null;
  }, 60000, 2000);
  check("calendar event cached by Thunderbird", titles, titles);

  // 13. Removing the account cleans up Thunderbird (nothing is deleted on Exchange)
  const st2 = await send({ type: "getState" });
  const removed = await send({ type: "removeAccount", params: { key: st2.accounts[0].key } });
  const gone = await waitFor(async () => {
    const accounts = await browser.accounts.list();
    const books = await browser.addressBooks.list();
    return !accounts.some(a => a.identities?.some(i => i.email == cfg.email)) && !books.some(b => b.name.includes(cfg.email)) ? true : null;
  }, 20000);
  const after = await state();
  check("account removal cleans up Thunderbird, keeps Exchange data", gone && !removed.error && after.inbox.length >= 1 && after.contacts.length >= 2, removed.error || null);
  }
} catch (e) {
  note(`ERROR ${e.message}\n${e.stack}`);
}
await report(true);

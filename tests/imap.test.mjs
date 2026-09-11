import { assert, assertEquals } from "./assert.mjs";
import { setupImap, MSG } from "./imap-harness.mjs";
import { MemoryStore } from "../core/store.mjs";
import { MockExchange } from "./mock-ews.mjs";

Deno.test("imap: greeting, capability, login", async () => {
  const t = await setupImap();
  try {
    const c = t.open();
    assert(c.conn.out.startsWith("* OK [CAPABILITY IMAP4rev1"));
    let r = await c.cmd("LOGIN user@example.org wrong");
    assert(/a1 NO \[AUTHENTICATIONFAILED\]/.test(r), r);
    r = await c.cmd("SELECT INBOX");
    assert(/a2 BAD Not authenticated/.test(r), r);
    r = await c.login();
    assert(/OK \[CAPABILITY .*UIDPLUS.*\] LOGIN/.test(r), r);
    const c2 = t.open();
    r = await c2.cmd("AUTHENTICATE PLAIN " + btoa("\0user@example.org\0tok"));
    assert(/a1 OK/.test(r), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: LIST with special-use, INBOX children, mUTF-7", async () => {
  const t = await setupImap();
  try {
    const inbox = t.ex.folder("inbox");
    t.ex.handle(`<s:Envelope xmlns:s="x"><s:Body><m:CreateFolder xmlns:m="m" xmlns:t="t"><m:ParentFolderId><t:FolderId Id="${inbox.id}"/></m:ParentFolderId><m:Folders><t:Folder><t:DisplayName>Prüfungen</t:DisplayName></t:Folder></m:Folders></m:CreateFolder></s:Body></s:Envelope>`);
    const c = t.open();
    await c.login();
    const r = await c.cmd('LIST "" "*"');
    assert(r.includes('* LIST (\\HasChildren) "/" "INBOX"'), r);
    assert(r.includes('* LIST (\\HasNoChildren) "/" "INBOX/Pr&APw-fungen"'), r);
    assert(r.includes('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"'), r);
    assert(r.includes('\\Trash) "/" "Deleted Items"'), r);
    assert(!r.includes("Calendar") && !r.includes("Outbox") && !r.includes("Contacts"), r);
    const r2 = await c.cmd('LIST (SPECIAL-USE) "" "*"');
    assert(!r2.includes('"INBOX"') && r2.includes("\\Drafts"), r2);
    const r3 = await c.cmd('LIST "" "%"');
    assert(!r3.includes("Pr&APw-fungen"), r3);
    const r4 = await c.cmd('LSUB "" "*"');
    assert(r4.includes('"INBOX/Pr&APw-fungen"'), r4);
  } finally {
    await t.close();
  }
});

Deno.test("imap: SELECT, header fetch without MIME download, body fetch sets \\Seen", async () => {
  const t = await setupImap();
  try {
    t.ex.addMessage("inbox", MSG("first"));
    t.ex.addMessage("inbox", MSG("zweite Nachricht", { from: `"Müller, Jörg" <j@example.org>` }), { isRead: true, flagged: true });
    const c = t.open();
    await c.login();
    let r = await c.cmd("SELECT INBOX");
    assert(r.includes("* 2 EXISTS"), r);
    assert(/\* OK \[UIDVALIDITY \d+\]/.test(r), r);
    assert(r.includes("[UIDNEXT 3]"), r);
    assert(r.includes("[READ-WRITE]"), r);

    r = await c.cmd("UID FETCH 1:* (FLAGS)");
    assert(r.includes("* 1 FETCH (UID 1 FLAGS ())"), r);
    assert(r.includes("* 2 FETCH (UID 2 FLAGS (\\Seen \\Flagged))"), r);

    const before = t.ex.requests.filter(x => x == "GetItem").length;
    r = await c.cmd("UID FETCH 1:2 (UID RFC822.SIZE FLAGS BODY.PEEK[HEADER.FIELDS (From To Subject Message-ID Content-Type)])");
    assertEquals(t.ex.requests.filter(x => x == "GetItem").length, before + 1, "one batched GetItem");
    assert(r.includes("BODY[HEADER.FIELDS (FROM TO SUBJECT MESSAGE-ID CONTENT-TYPE)] {"), r);
    assert(r.includes("Subject: first\r\n"), r);
    assert(r.includes('From: =?UTF-8?B?'), r);
    assert(!r.includes("Date:"), "only requested fields");

    r = await c.cmd("UID FETCH 1 (UID RFC822.SIZE BODY[])");
    assert(r.includes("Hello first"), r);
    assert(/FLAGS \(\\Seen\)/.test(r), r);
    const m = /RFC822\.SIZE (\d+) BODY\[\] \{(\d+)\}/.exec(r);
    assertEquals(m[1], m[2], "exact size once MIME is known");
    const item = t.ex.itemsIn("inbox").find(i => i.mime.includes("first"));
    assertEquals(item.isRead, true);
  } finally {
    await t.close();
  }
});

Deno.test("imap: STORE flags round-trip to Exchange", async () => {
  const t = await setupImap();
  try {
    const item = t.ex.addMessage("inbox", MSG("x"));
    const c = t.open();
    await c.login();
    await c.cmd("SELECT INBOX");
    let r = await c.cmd("UID STORE 1 +FLAGS (\\Flagged \\Answered)");
    assert(r.includes("* 1 FETCH (UID 1 FLAGS (\\Flagged \\Answered))"), r);
    assertEquals(item.ext["0x1090"], "2");
    assertEquals(item.ext["0x1081"], "102");
    r = await c.cmd("UID STORE 1 -FLAGS.SILENT (\\Flagged)");
    assert(!r.includes("FETCH"), r);
    assertEquals(item.ext["0x1090"], undefined);
    r = await c.cmd("UID STORE 1 +FLAGS ($Forwarded Junk)");
    assert(r.includes("$Forwarded") && r.includes("Junk"), r);
    // a second session sees the server state after sync
    const c2 = t.open();
    await c2.login();
    await c2.cmd("SELECT INBOX");
    r = await c2.cmd("FETCH 1 FLAGS");
    assert(r.includes("\\Answered"), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: external changes appear via NOOP (EXISTS, FETCH, EXPUNGE)", async () => {
  const t = await setupImap();
  try {
    const a = t.ex.addMessage("inbox", MSG("a"));
    t.ex.addMessage("inbox", MSG("b"));
    const c = t.open();
    await c.login();
    await c.cmd("SELECT INBOX");
    t.ex.addMessage("inbox", MSG("c"));
    let r = await c.cmd("NOOP");
    assert(r.includes("* 3 EXISTS"), r);
    // mark read on server, delete on server
    t.ex.handle(`<s:Envelope xmlns:s="x"><s:Body><m:UpdateItem xmlns:m="m" xmlns:t="t"><m:ItemChanges><t:ItemChange><t:ItemId Id="${a.id}"/><t:Updates><t:SetItemField><t:FieldURI FieldURI="message:IsRead"/><t:Message><t:IsRead>true</t:IsRead></t:Message></t:SetItemField></t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem></s:Body></s:Envelope>`);
    r = await c.cmd("NOOP");
    assert(r.includes("* 1 FETCH (UID 1 FLAGS (\\Seen))"), r);
    t.ex.handle(`<s:Envelope xmlns:s="x"><s:Body><m:DeleteItem xmlns:m="m" xmlns:t="t" DeleteType="HardDelete" SendMeetingCancellations="SendToNone"><m:ItemIds><t:ItemId Id="${a.id}"/></m:ItemIds></m:DeleteItem></s:Body></s:Envelope>`);
    r = await c.cmd("NOOP");
    assert(r.includes("* 1 EXPUNGE"), r);
    r = await c.cmd("UID FETCH 1:* (FLAGS)");
    assert(!r.includes("UID 1 "), r);
    assert(r.includes("* 1 FETCH (UID 2"), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: MOVE with COPYUID, COPY, delete+EXPUNGE", async () => {
  const t = await setupImap();
  try {
    for (const s of ["a", "b", "c"]) t.ex.addMessage("inbox", MSG(s));
    const c = t.open();
    await c.login();
    await c.cmd("SELECT INBOX");
    let r = await c.cmd('UID MOVE 1:2 "Deleted Items"');
    assert(/\* OK \[COPYUID \d+ 1:2 1:2\]/.test(r), r);
    assert(r.includes("* 2 EXPUNGE") && r.includes("* 1 EXPUNGE"), r);
    assertEquals(t.ex.itemsIn("inbox").length, 1);
    assertEquals(t.ex.itemsIn("deleteditems").length, 2);
    r = await c.cmd('UID COPY 3 "Drafts"');
    assert(/OK \[COPYUID \d+ 3 1\] UID COPY/.test(r), r);
    r = await c.cmd("UID STORE 3 +FLAGS (\\Deleted)");
    r = await c.cmd("EXPUNGE");
    assert(r.includes("* 1 EXPUNGE"), r);
    assertEquals(t.ex.itemsIn("inbox").length, 0);
    // No duplicate after the destination folder syncs the moved items
    r = await c.cmd('SELECT "Deleted Items"');
    assert(r.includes("* 2 EXISTS"), r);
    r = await c.cmd('UID MOVE 1 "Nonexistent"');
    assert(r.includes("NO [TRYCREATE]"), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: APPEND draft with LITERAL+ and synchronizing literal", async () => {
  const t = await setupImap();
  try {
    const c = t.open();
    await c.login();
    const msg = MSG("draft1");
    let r = await c.cmd(`APPEND Drafts (\\Seen \\Draft) "01-Sep-2026 10:00:00 +0200" {${msg.length}+}`, { literal: msg + "\r\n" });
    assert(/OK \[APPENDUID \d+ 1\] APPEND/.test(r), r);
    const [d] = t.ex.itemsIn("drafts");
    assertEquals(d.ext["0x0E07"], "9");
    assertEquals(d.ext["0x0E06"], "2026-09-01T08:00:00Z");
    // synchronizing literal: server must send a continuation
    const tagLine = `a9 APPEND Drafts {${msg.length}}\r\n`;
    const start = c.conn.out.length;
    c.raw(tagLine);
    await new Promise(r => setTimeout(r, 10));
    assert(c.since(start).startsWith("+ "), c.since(start));
    c.raw(msg + "\r\n");
    for (let i = 0; i < 200 && !/a9 OK/.test(c.since(start)); i++) await new Promise(r => setTimeout(r, 5));
    assert(/a9 OK \[APPENDUID \d+ 2\]/.test(c.since(start)), c.since(start));
    r = await c.cmd("SELECT Drafts");
    assert(r.includes("* 2 EXISTS"), r);
    r = await c.cmd("FETCH 1 FLAGS");
    assert(r.includes("\\Seen \\Draft"), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: folder CREATE, RENAME, DELETE", async () => {
  const t = await setupImap();
  try {
    const c = t.open();
    await c.login();
    let r = await c.cmd('CREATE "INBOX/Projekte"');
    assert(r.includes("OK"), r);
    r = await c.cmd('CREATE "Archiv"');
    r = await c.cmd('CREATE "Archiv/2026"');
    r = await c.cmd('RENAME "INBOX/Projekte" "Archiv/Projekte alt"');
    assert(r.includes("OK"), r);
    r = await c.cmd('LIST "" "*"');
    assert(r.includes('"Archiv/Projekte alt"') && !r.includes('"INBOX/Projekte"'), r);
    r = await c.cmd('DELETE "Archiv/2026"');
    assert(r.includes("OK"), r);
    r = await c.cmd('DELETE "Sent Items"');
    assert(r.includes("NO [CANNOT]"), r);
    r = await c.cmd('CREATE "Archiv"');
    assert(r.includes("NO [ALREADYEXISTS]"), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: SEARCH flags and text via EWS", async () => {
  const t = await setupImap();
  try {
    t.ex.addMessage("inbox", MSG("Budget 2027", { body: "numbers" }));
    t.ex.addMessage("inbox", MSG("Lunch"), { isRead: true });
    t.ex.addMessage("inbox", MSG("Re: budget"), { flagged: true });
    const c = t.open();
    await c.login();
    await c.cmd("SELECT INBOX");
    let r = await c.cmd("UID SEARCH UNSEEN");
    assert(r.includes("* SEARCH 1 3"), r);
    r = await c.cmd("SEARCH SUBJECT budget");
    assert(r.includes("* SEARCH 1 3"), r);
    r = await c.cmd("UID SEARCH FLAGGED SUBJECT budget");
    assert(r.includes("* SEARCH 3\r\n"), r);
    r = await c.cmd('SEARCH OR SEEN FLAGGED');
    assert(r.includes("* SEARCH 2 3"), r);
    r = await c.cmd("SEARCH NOT SUBJECT budget");
    assert(r.includes("* SEARCH 2\r\n"), r);
    r = await c.cmd("SEARCH CHARSET UTF-8 BODY numbers");
    assert(r.includes("* SEARCH 1\r\n"), r);
  } finally {
    await t.close();
  }
});

Deno.test("imap: IDLE pushes new mail", async () => {
  const t = await setupImap();
  try {
    t.ex.addMessage("inbox", MSG("a"));
    const c = t.open();
    await c.login();
    await c.cmd("SELECT INBOX");
    const start = c.conn.out.length;
    c.raw("i1 IDLE\r\n");
    await new Promise(r => setTimeout(r, 20));
    assert(c.since(start).startsWith("+ idling"));
    t.ex.addMessage("inbox", MSG("b"));
    for (let i = 0; i < 100 && !c.since(start).includes("* 2 EXISTS"); i++) await new Promise(r => setTimeout(r, 10));
    assert(c.since(start).includes("* 2 EXISTS"), c.since(start));
    c.raw("DONE\r\n");
    for (let i = 0; i < 100 && !c.since(start).includes("i1 OK"); i++) await new Promise(r => setTimeout(r, 5));
    assert(c.since(start).includes("i1 OK IDLE terminated"));
  } finally {
    await t.close();
  }
});

Deno.test("imap: BODYSTRUCTURE and part fetch", async () => {
  const t = await setupImap();
  try {
    const mime = [
      "From: a@example.org", "To: user@example.org", "Subject: parts", "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="XX"', "", "--XX", "Content-Type: text/plain; charset=utf-8", "", "Body text",
      "--XX", "Content-Type: application/pdf; name=\"r.pdf\"", "Content-Disposition: attachment; filename=\"r.pdf\"", "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQ=", "--XX--", "",
    ].join("\r\n");
    t.ex.addMessage("inbox", mime);
    const c = t.open();
    await c.login();
    await c.cmd("SELECT INBOX");
    let r = await c.cmd("UID FETCH 1 (BODYSTRUCTURE)");
    assert(r.includes('("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 9 1'), r);
    assert(r.includes('("ATTACHMENT" ("FILENAME" "r.pdf"))'), r);
    r = await c.cmd("UID FETCH 1 (BODY.PEEK[2] BODY.PEEK[1.MIME] BODY.PEEK[]<0.4>)");
    assert(r.includes("BODY[2] {12}\r\nJVBERi0xLjQ="), r);
    assert(r.includes("BODY[1.MIME] {"), r);
    assert(r.includes("BODY[]<0> {4}\r\nFrom"), r);
    assert(!r.includes("\\Seen"), "PEEK does not set seen");
  } finally {
    await t.close();
  }
});

Deno.test("imap: UIDs survive restart (persisted state)", async () => {
  const store = new MemoryStore();
  const ex = new MockExchange();
  let t = await setupImap({ store, ex });
  for (const s of ["a", "b", "c"]) ex.addMessage("inbox", MSG(s));
  let c = t.open();
  await c.login();
  let r = await c.cmd("SELECT INBOX");
  const validity = /UIDVALIDITY (\d+)/.exec(r)[1];
  await c.cmd("UID MOVE 1 Drafts");
  await t.close();
  ex.addMessage("inbox", MSG("d"));
  t = await setupImap({ store, ex });
  try {
    c = t.open();
    await c.login();
    r = await c.cmd("SELECT INBOX");
    assertEquals(/UIDVALIDITY (\d+)/.exec(r)[1], validity);
    r = await c.cmd("UID FETCH 1:* (UID)");
    assert(r.includes("UID 2") && r.includes("UID 3") && r.includes("UID 4") && !r.includes("UID 1)"), r);
    const syncs = ex.requests.filter(x => x == "SyncFolderItems").length;
    assert(syncs >= 1);
  } finally {
    await t.close();
  }
});

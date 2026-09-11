import { assert, assertEquals, assertRejects } from "./assert.mjs";
import { MockExchange, basicTransport } from "./mock-ews.mjs";
import { EwsClient } from "../core/ews/client.mjs";
import { EwsClient as C2 } from "../core/ews/client.mjs";
import { PROP } from "../core/ews/items.mjs";
import { autodiscover, guessEwsUrls } from "../core/ews/autodiscover.mjs";

const MSG = (subj, extra = "") => `From: Alice <alice@example.org>\r\nTo: user@example.org\r\nSubject: ${subj}\r\nDate: Tue, 1 Sep 2026 10:00:00 +0000\r\nMessage-ID: <${subj.replace(/\W/g, "")}@x>\r\n${extra}\r\nHello ${subj}\r\n`;

function setup() {
  const ex = new MockExchange();
  const server = ex.serve();
  const client = new EwsClient({ url: ex.url, transport: basicTransport("user", "secret") });
  return { ex, server, client };
}

Deno.test("ews: distinguished folders and deep folder listing", async () => {
  const { ex, server, client } = setup();
  try {
    const d = await client.getDistinguishedFolders();
    assertEquals(d.inbox.displayName, "Inbox");
    assert(!d.archivemsgfolderroot, "missing folders are skipped");
    await client.createFolder(d.inbox.id, "Projects");
    const all = await client.findFoldersDeep();
    assert(all.some(f => f.displayName == "Projects" && f.parentId == d.inbox.id));
    assertEquals(client.serverVersion.major, 15);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: auth failure is reported as EwsAuthError", async () => {
  const ex = new MockExchange();
  const server = ex.serve();
  try {
    const bad = new EwsClient({ url: ex.url, transport: basicTransport("user", "wrong") });
    await assertRejects(() => bad.probe(), /AuthenticationFailed/);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: sync, get mime, flags, move, delete", async () => {
  const { ex, server, client } = setup();
  try {
    ex.addMessage("inbox", MSG("one"));
    ex.addMessage("inbox", MSG("two"), { isRead: true, flagged: true });
    let r = await client.syncFolderItems("@inbox", null);
    assertEquals(r.changes.length, 2);
    assert(r.includesLast);
    const two = r.changes.find(c => c.item.isRead);
    assertEquals(two.item.ext["0x1090"], "2");
    const mime = await client.getMime(two.id);
    assert(mime.includes("Subject: two"));

    // no changes
    const state = r.syncState;
    r = await client.syncFolderItems("@inbox", state);
    assertEquals(r.changes.length, 0);

    // read flag + flag status
    const one = (await client.syncFolderItems("@inbox", null)).changes.find(c => !c.item.isRead);
    await client.updateItems([{ id: one.id, set: [EwsClient.setField("message:IsRead", "Message", "<t:IsRead>true</t:IsRead>"), EwsClient.setExtended(PROP.FLAG_STATUS, "Message", 2)] }]);
    r = await client.syncFolderItems("@inbox", state);
    assertEquals(r.changes.length, 1);
    assertEquals(r.changes[0].type, "update");
    assertEquals(r.changes[0].item.isRead, true);

    // move returns new id
    const [moved] = await client.moveItems([one.id], "@deleteditems");
    assert(moved.id && moved.id != one.id);
    r = await client.syncFolderItems("@inbox", r.syncState);
    assertEquals(r.changes.map(c => c.type), ["delete"]);

    await client.deleteItems([moved.id]);
    assertEquals(ex.itemsIn("deleteditems").length, 0);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: paged initial sync", async () => {
  const { ex, server, client } = setup();
  try {
    for (let i = 0; i < 25; i++) ex.addMessage("inbox", MSG("m" + i));
    let state = null;
    const ids = new Set();
    for (let n = 0; n < 10; n++) {
      const r = await client.syncFolderItems("@inbox", state, { max: 10 });
      r.changes.forEach(c => ids.add(c.id));
      state = r.syncState;
      if (r.includesLast) break;
    }
    assertEquals(ids.size, 25);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: create from MIME (draft, send with saved copy)", async () => {
  const { ex, server, client } = setup();
  try {
    const d = await client.createItemFromMime(MSG("draft"), { folder: "@drafts", messageFlags: 8 });
    assert(d.id);
    assertEquals(ex.itemsIn("drafts").length, 1);
    await client.createItemFromMime(MSG("sent"), { folder: "@sentitems", disposition: "SendAndSaveCopy" });
    assertEquals(ex.sent.length, 1);
    assertEquals(ex.itemsIn("sentitems").length, 1);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: SOAP fault and throttling retry", async () => {
  const { ex, server, client } = setup();
  try {
    ex.failNext = { op: "GetFolder", code: "ErrorServerBusy" };
    client.setTimeout = (fn) => setTimeout(fn, 1);
    const { inbox } = await client.probe();
    assertEquals(inbox.displayName, "Inbox");
    ex.failNext = { op: "GetFolder", code: "ErrorAccessDenied", message: "nope" };
    await assertRejects(() => client.probe(), /ErrorAccessDenied/);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: schema version fallback", async () => {
  const { ex, server, client } = setup();
  try {
    ex.failNext = { op: "GetFolder", code: "ErrorInvalidServerVersion" };
    await client.probe();
    assertEquals(client.version, "Exchange2010_SP2");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ews: resolve names", async () => {
  const { ex, server, client } = setup();
  try {
    ex.directory.push({ name: "Schmidt, Anna", email: "anna.schmidt@example.org" }, { name: "Schmitz, Bernd", email: "b.schmitz@example.org" });
    const r = await client.resolveNames("schm");
    assertEquals(r.map(x => x.email), ["anna.schmidt@example.org", "b.schmitz@example.org"]);
    assertEquals(await client.resolveNames("zzz"), []);
  } finally {
    await server.shutdown();
  }
});

Deno.test("autodiscover", async () => {
  const ex = new MockExchange();
  const server = ex.serve();
  try {
    const port = server.addr.port;
    // Route https://example.org/... to the mock by rewriting in the transport.
    const t = basicTransport("user", "secret");
    const rewriting = { request: o => t.request({ ...o, url: o.url.replace(/^https:\/\/example\.org/, `http://127.0.0.1:${port}`) }) };
    const r = await autodiscover("user@example.org", rewriting);
    assertEquals(r.ewsUrl, `http://127.0.0.1:${port}/EWS/Exchange.asmx`);
    assertEquals(r.displayName, "Test User");
    assert(guessEwsUrls("a@tu-dortmund.de").includes("https://outlook.tu-dortmund.de/EWS/Exchange.asmx"));
  } finally {
    await server.shutdown();
  }
});

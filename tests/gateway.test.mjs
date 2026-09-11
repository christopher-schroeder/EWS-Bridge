import { assert, assertEquals } from "./assert.mjs";
import { MockExchange, basicTransport } from "./mock-ews.mjs";
import { Gateway } from "../core/gateway.mjs";
import { denoPlatform } from "./deno-platform.mjs";

async function talk(port) {
  const c = await Deno.connect({ hostname: "127.0.0.1", port });
  let buf = "";
  const dec = new TextDecoder();
  (async () => { const b = new Uint8Array(65536); for (;;) { const n = await c.read(b).catch(() => null); if (n === null) break; buf += dec.decode(b.subarray(0, n)); } })();
  const until = async re => { for (let i = 0; i < 500; i++) { if (re.test(buf)) return buf; await new Promise(r => setTimeout(r, 5)); } throw new Error("timeout: " + buf); };
  return { send: s => c.write(new TextEncoder().encode(s)), until, get buf() { return buf; }, close: () => c.close() };
}

Deno.test("gateway: IMAP, SMTP and DAV over real sockets", async () => {
  const ex = new MockExchange();
  const server = ex.serve();
  ex.addMessage("inbox", "From: a@example.org\r\nSubject: hello\r\n\r\nbody\r\n");
  const gw = new Gateway({ platform: denoPlatform({ transportFor: () => basicTransport("user", "secret") }), logLevel: "warn" });
  gw.addAccount({ key: "k1", email: "user@example.org", ewsUrl: ex.url, localPassword: "tok" });
  const ports = await gw.start({});
  try {
    assert(ports.imap && ports.smtp && ports.dav);
    const imap = await talk(ports.imap);
    await imap.until(/\* OK/);
    await imap.send("a LOGIN user@example.org tok\r\nb SELECT INBOX\r\nc UID FETCH 1 (BODY[])\r\n");
    await imap.until(/c OK/);
    assert(imap.buf.includes("* 1 EXISTS") && imap.buf.includes("Subject: hello"), imap.buf);
    await imap.send("d LOGOUT\r\n");
    await imap.until(/d OK/);

    const smtp = await talk(ports.smtp);
    await smtp.until(/^220 /m);
    await smtp.send(`EHLO x\r\nAUTH PLAIN ${btoa("\0user@example.org\0tok")}\r\nMAIL FROM:<user@example.org>\r\nRCPT TO:<b@example.org>\r\nDATA\r\n`);
    await smtp.until(/354 /);
    await smtp.send("From: user@example.org\r\nTo: b@example.org\r\nSubject: out\r\n\r\nhi\r\n.\r\nQUIT\r\n");
    await smtp.until(/221 /);
    assertEquals(ex.sent.length, 1);

    const res = await fetch(`http://127.0.0.1:${ports.dav}/calendars/k1/`, { method: "PROPFIND", headers: { Depth: "1", Authorization: "Basic " + btoa("user@example.org:tok") }, body: `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>` });
    const text = await res.text();
    assertEquals(res.status, 207);
    assert(text.includes("/calendars/k1/calendar/") && text.includes("Calendar"), text);
    const bad = await fetch(`http://127.0.0.1:${ports.dav}/calendars/k1/`, { method: "PROPFIND", headers: { Authorization: "Basic " + btoa("user@example.org:nope") } });
    await bad.text();
    assertEquals(bad.status, 401);
    imap.close(); smtp.close();
  } finally {
    await gw.stop();
    await server.shutdown();
  }
});

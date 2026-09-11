import { assert, assertEquals } from "./assert.mjs";
import { SmtpSession, ewsSender, prepareForExchange } from "../core/smtp/session.mjs";
import { MockExchange, basicTransport } from "./mock-ews.mjs";
import { EwsClient } from "../core/ews/client.mjs";
import { TestConn } from "./imap-harness.mjs";

async function waitFor(conn, re) {
  for (let i = 0; i < 500; i++) {
    if (re.test(conn.out)) return conn.out;
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error("timeout; got: " + conn.out);
}

Deno.test("smtp: full submission through EWS with Bcc and dot-unstuffing", async () => {
  const ex = new MockExchange();
  const server = ex.serve();
  try {
    const ews = new EwsClient({ url: ex.url, transport: basicTransport("user", "secret") });
    const conn = new TestConn();
    const s = new SmtpSession({ conn, authenticate: async (u, p) => (p == "tok" ? ewsSender(ews) : null) });
    assert(conn.out.startsWith("220 "));
    s.data("EHLO client\r\n");
    await waitFor(conn, /250 PIPELINING/);
    s.data("MAIL FROM:<user@example.org>\r\n");
    await waitFor(conn, /530 /);
    s.data("AUTH PLAIN " + btoa("\0user@example.org\0bad") + "\r\n");
    await waitFor(conn, /535 /);
    s.data("AUTH LOGIN\r\n");
    await waitFor(conn, /334 VXNlcm5hbWU6/);
    s.data(btoa("user@example.org") + "\r\n");
    await waitFor(conn, /334 UGFzc3dvcmQ6/);
    s.data(btoa("tok") + "\r\n");
    await waitFor(conn, /235 /);
    // pipelined envelope
    s.data("MAIL FROM:<user@example.org> SIZE=300\r\nRCPT TO:<bob@example.com>\r\nRCPT TO:<secret@example.com>\r\nDATA\r\n");
    await waitFor(conn, /354 /);
    s.data("From: user@example.org\r\nTo: Bob <bob@example.com>\r\nSubject: hi\r\n\r\nline one\r\n..dot line\r\n");
    s.data(".\r\n");
    await waitFor(conn, /250 2\.0\.0 Message handed/);
    assertEquals(ex.sent.length, 1);
    const mime = ex.sent[0].mime;
    assert(mime.includes("Bcc: secret@example.com\r\n"), mime);
    assert(mime.includes("\r\n.dot line\r\n"), mime);
    assertEquals(ex.itemsIn("sentitems").length, 1);
    s.data("QUIT\r\n");
    await waitFor(conn, /221 /);
    assert(conn.closed);
  } finally {
    await server.shutdown();
  }
});

Deno.test("smtp: Exchange error surfaces as 554", async () => {
  const ex = new MockExchange();
  const server = ex.serve();
  try {
    const ews = new EwsClient({ url: ex.url, transport: basicTransport("user", "secret") });
    const conn = new TestConn();
    const s = new SmtpSession({ conn, authenticate: async () => ewsSender(ews) });
    ex.failNext = { op: "CreateItem", code: "ErrorSendAsDenied", message: "The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account." };
    s.data("EHLO x\r\nAUTH PLAIN " + btoa("\0a\0b") + "\r\nMAIL FROM:<other@example.org>\r\nRCPT TO:<x@y.z>\r\nDATA\r\n");
    await waitFor(conn, /354 /);
    s.data("From: other@example.org\r\nTo: x@y.z\r\nSubject: t\r\n\r\nbody\r\n.\r\n");
    await waitFor(conn, /554 5\.0\.0 Exchange refused the message: ErrorSendAsDenied/);
  } finally {
    await server.shutdown();
  }
});

Deno.test("smtp: prepareForExchange leaves visible recipients alone", () => {
  const m = "To: a@x.de\r\nCc: B <b@x.de>\r\n\r\nx";
  assertEquals(prepareForExchange(m, ["A@x.de", "b@x.de"]), m);
});

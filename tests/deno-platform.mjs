/* Platform adapter for running the gateway under Deno (tests, and the
 * standalone test server used for end-to-end runs with a real Thunderbird). */

import { bytesToBinary, binaryToBytes } from "../core/util.mjs";
import { MemoryStore } from "../core/store.mjs";

export function denoPlatform({ transportFor, store = new MemoryStore(), logSink = null, defaultTimeZone = "Europe/Berlin" }) {
  return {
    store,
    transportFor,
    defaultTimeZone,
    logSink,
    timers: {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: id => clearTimeout(id),
      setInterval: (f, ms) => setInterval(f, ms),
      clearInterval: id => clearInterval(id),
    },
    async listen(port, onConnection) {
      const listener = Deno.listen({ hostname: "127.0.0.1", port });
      (async () => {
        for await (const c of listener) {
          let closed = false;
          let queue = Promise.resolve();
          const conn = {
            write(bin) {
              const bytes = binaryToBytes(bin);
              queue = queue.then(async () => {
                let off = 0;
                while (off < bytes.length && !closed) off += await c.write(bytes.subarray(off));
              }).catch(() => {});
            },
            close() {
              if (closed) return;
              queue.then(() => { closed = true; try { c.close(); } catch {} });
            },
          };
          const session = onConnection(conn);
          (async () => {
            const buf = new Uint8Array(65536);
            try {
              for (;;) {
                const n = await c.read(buf);
                if (n === null) break;
                session.data(bytesToBinary(buf.subarray(0, n)));
              }
            } catch {}
            closed = true;
            session.close();
          })();
        }
      })().catch(() => {});
      return { port: listener.addr.port, close: () => listener.close() };
    },
  };
}

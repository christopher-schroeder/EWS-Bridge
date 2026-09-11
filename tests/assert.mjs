// Tiny assertion helpers (no network fetch of std libs needed).
export function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}
export function assertEquals(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg ? msg + ": " : ""}expected ${sb}\n     got ${sa}`);
}
export async function assertRejects(fn, pattern) {
  try { await fn(); } catch (e) {
    if (pattern && !pattern.test(String(e?.message ?? e))) throw new Error(`wrong error: ${e?.message}`);
    return e;
  }
  throw new Error("expected rejection");
}

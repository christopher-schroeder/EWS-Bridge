/* EWS Bridge — persistence interface.
 * A store keeps JSON documents by key. Implementations: MemoryStore (tests),
 * and the Gecko store in the extension (files in the profile directory).
 */

export class MemoryStore {
  constructor() {
    this.data = new Map();
  }

  async load(key) {
    const v = this.data.get(key);
    return v === undefined ? null : JSON.parse(v);
  }

  async save(key, value) {
    this.data.set(key, JSON.stringify(value));
  }

  async remove(key) {
    this.data.delete(key);
  }
}

/** Wraps a store with a per-key debounce for frequently-updated documents. */
export class DebouncedWriter {
  constructor(store, delayMs = 2000, timers = globalThis) {
    this.store = store;
    this.delayMs = delayMs;
    this.timers = timers;
    this.pending = new Map(); // key -> { producer, timer }
  }

  /** Schedule saving producer() under key. */
  schedule(key, producer) {
    const p = this.pending.get(key);
    if (p) {
      p.producer = producer;
      return;
    }
    const entry = { producer, timer: null };
    entry.timer = this.timers.setTimeout(() => this.#flushKey(key), this.delayMs);
    this.pending.set(key, entry);
  }

  async #flushKey(key) {
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    this.pending.delete(key);
    this.timers.clearTimeout(entry.timer);
    await this.store.save(key, entry.producer());
  }

  async flush() {
    await Promise.all([...this.pending.keys()].map(k => this.#flushKey(k)));
  }
}

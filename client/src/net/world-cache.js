import { Events } from './events.js';
export const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

// All retained world DTOs (including dynamic state) are accounted once by key.
// Offers reserve bytes BEFORE a chunk request. Unsolicited chunk payloads are rejected.
export class WorldCache extends Events {
  constructor() { super(); this.reset(); }
  reset(total = 0) {
    for (const key of this.entries?.keys() || []) this.emit('evict', key);
    this.total = total; this.entries = new Map(); this.clock = 0;
  }
  get used() { return [...this.entries.values()].reduce((sum, e) => sum + e.bytes, 0); }
  reserve(key, bytes, { pinned = false, distance = 0 } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.total <= 0) return false;
    if (this.entries.has(key)) return false;
    const hard = Math.floor(this.total * .1);
    if (bytes > hard) return false;
    const candidates = [...this.entries].filter(([,e]) => !e.pinned && e.data !== null)
      .sort((a,b) => a[1].touched - b[1].touched || b[1].distance - a[1].distance);
    for (const [id] of candidates) {
      if (this.used + bytes <= hard) break;
      this.drop(id);
    }
    if (this.used + bytes > hard) return false;
    this.entries.set(key, { bytes, pinned, distance, touched: ++this.clock, data: null });
    this.emit('stats', this.stats()); return true;
  }
  commit(key, data) {
    const entry = this.entries.get(key);
    if (!entry || entry.data !== null) return false;
    if (byteSize(data) !== entry.bytes) { this.drop(key); return false; }
    entry.data = data; entry.touched = ++this.clock;
    this.emit('stats', this.stats()); return true;
  }
  put(key, data, options = {}) {
    this.drop(key);
    return this.reserve(key, byteSize(data), options) && this.commit(key, data);
  }
  drop(key) {
    if (!this.entries.delete(key)) return;
    this.emit('evict', key); this.emit('stats', this.stats());
  }
  stats() {
    const chunks = [...this.entries].filter(([key]) => key.startsWith('chunk:'));
    return { bytes: this.used, totalBytes: this.total, percent: this.total ? this.used / this.total * 100 : 0,
      chunks: chunks.filter(([,e]) => e.data).length,
      queuedBytes: [...this.entries.values()].filter(e => e.data === null).reduce((n,e) => n + e.bytes,0),
      targetPercent: 5, limitPercent: 10 };
  }
}

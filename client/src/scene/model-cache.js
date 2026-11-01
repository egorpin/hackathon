const CACHE_NAME = 'mars-colony-models-v1';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 12;
const ALLOWED_NAMES = new Set(['astronaut','drill','oxygen_generator','storage','dome_base','rover','solar_panel','wind_turbine','robot_minion']);

// Only versioned, approved model paths are accepted; API and unversioned requests
// always stay outside this cache. GLBs contain their textures in the same file.
export class ModelCache {
  constructor({ storage = globalThis.caches, fetcher = (...args) => globalThis.fetch(...args), origin = globalThis.location?.origin } = {}) {
    this.storage = storage;
    this.fetcher = fetcher;
    this.origin = origin;
    this.pending = new Map();
    this.writes = Promise.resolve();
    this.stats = { hits: 0, misses: 0 };
  }
  async get(name, revision) {
    if (!ALLOWED_NAMES.has(name)) throw new Error('Invalid model name');
    const path = `/assets/models/${name}.glb${revision ? `?v=${encodeURIComponent(revision)}` : ''}`;
    if (!revision || !this.origin) return this.download(path);
    const url = new URL(path, this.origin).href;
    if (this.pending.has(url)) return this.pending.get(url);
    const request = this.read(url).finally(() => this.pending.delete(url));
    this.pending.set(url, request);
    return request;
  }
  async invalidate(name, revision) {
    if (!revision || !this.origin || !ALLOWED_NAMES.has(name)) return false;
    try {
      const cache = await this.storage?.open(CACHE_NAME);
      return await cache?.delete(new URL(`/assets/models/${name}.glb?v=${encodeURIComponent(revision)}`, this.origin).href) || false;
    } catch { return false; }
  }
  async read(url) {
    let cache;
    try {
      cache = await this.storage?.open(CACHE_NAME);
      const cached = await cache?.match(url);
      if (cached) {
        const bytes = await cached.arrayBuffer();
        if (validGlb(bytes)) { this.stats.hits++; return bytes; }
        await cache.delete(url);
      }
    } catch { cache = null; }
    this.stats.misses++;
    const bytes = await this.download(url);
    if (cache && bytes.byteLength <= MAX_BYTES && validGlb(bytes)) {
      // Serialize writes so concurrent downloads cannot bypass the size bound.
      this.writes = this.writes.catch(() => {}).then(() => this.store(cache, url, bytes));
      await this.writes.catch(() => {});
    }
    return bytes;
  }
  async download(url) {
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${url}`);
    return response.arrayBuffer();
  }
  async store(cache, url, bytes) {
    const keys = await cache.keys();
    const path = new URL(url).pathname;
    const entries = [];
    for (const key of keys) {
      const response = await cache.match(key);
      if (!response) continue;
      if (new URL(key.url).pathname === path) { await cache.delete(key); continue; }
      entries.push({ key, size: Number(response.headers.get('x-model-size')) || MAX_BYTES,
        time: Number(response.headers.get('x-model-stored')) || 0 });
    }
    entries.sort((a,b) => a.time - b.time);
    let size = entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length >= MAX_ENTRIES || size + bytes.byteLength > MAX_BYTES) {
      const entry = entries.shift();
      if (!entry) break;
      await cache.delete(entry.key); size -= entry.size;
    }
    await cache.put(url, new Response(bytes.slice(0), { headers: {
      'content-type': 'model/gltf-binary', 'x-model-size': String(bytes.byteLength),
      'x-model-stored': String(Date.now()),
    } }));
  }
}
function validGlb(bytes) {
  return bytes.byteLength >= 12 && new DataView(bytes).getUint32(0, true) === 0x46546c67;
}

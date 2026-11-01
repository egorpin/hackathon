const CACHE_NAME = 'mars-colony-models-v1';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 12;
const ALLOWED_NAMES = new Set(['astronaut','drill','oxygen_generator','storage','dome_base','rover','solar_panel','wind_turbine','robot_minion']);

// Only versioned, approved model paths are accepted; API and unversioned requests
// always stay outside this cache. GLBs contain their textures in the same file.
export class ModelCache {
  constructor({ storage = globalThis.caches, fetcher = (...args) => globalThis.fetch(...args), origin = globalThis.location?.origin, maxMemoryBytes = 8 * 1024 * 1024 } = {}) {
    this.storage = storage;
    this.fetcher = fetcher;
    this.origin = origin;
    this.pending = new Map();
    this.memory = new Map();
    this.memoryBytes = 0;
    this.maxMemoryBytes = maxMemoryBytes;
    this.memoryGeneration = 0;
    this.reload = new Set();
    this.writes = Promise.resolve();
    this.stats = { hits: 0, misses: 0 };
  }
  async get(name, revision) {
    if (!ALLOWED_NAMES.has(name)) throw new Error('Invalid model name');
    const path = `/assets/models/${name}.glb${revision ? `?v=${encodeURIComponent(revision)}` : ''}`;
    if (!revision || !this.origin) return this.download(path);
    const url = new URL(path, this.origin).href;
    const cached = this.memory.get(url);
    if (cached) {
      this.memory.delete(url); this.memory.set(url, cached);
      this.stats.hits++;
      return cached.slice(0);
    }
    if (this.pending.has(url)) return (await this.pending.get(url)).slice(0);
    const generation = this.memoryGeneration;
    const request = this.read(url).then(bytes => {
      if (generation === this.memoryGeneration) this.remember(url, bytes);
      return bytes;
    }).finally(() => this.pending.delete(url));
    this.pending.set(url, request);
    return (await request).slice(0);
  }
  clearMemory() {
    this.memoryGeneration++;
    this.memory.clear(); this.memoryBytes = 0;
  }
  forget(url) {
    const bytes = this.memory.get(url);
    if (bytes) this.memoryBytes -= bytes.byteLength;
    this.memory.delete(url);
  }
  remember(url, bytes) {
    if (bytes.byteLength > this.maxMemoryBytes) return;
    const path = new URL(url).pathname;
    for (const key of this.memory.keys()) if (new URL(key).pathname === path) this.forget(key);
    while (this.memoryBytes + bytes.byteLength > this.maxMemoryBytes && this.memory.size) {
      this.forget(this.memory.keys().next().value);
    }
    this.memory.set(url, bytes.slice(0)); this.memoryBytes += bytes.byteLength;
  }
  async invalidate(name, revision) {
    if (!revision || !this.origin || !ALLOWED_NAMES.has(name)) return false;
    const url = new URL(`/assets/models/${name}.glb?v=${encodeURIComponent(revision)}`, this.origin).href;
    this.forget(url); this.reload.add(url);
    // A pending persistent write must not restore the invalidated response.
    await this.writes.catch(() => {});
    try {
      const cache = await this.storage?.open(CACHE_NAME);
      await cache?.delete(url);
    } catch { /* HTTP/memory-only mode still supports a fresh retry. */ }
    return true;
  }
  async read(url) {
    let cache;
    try {
      cache = await this.storage?.open(CACHE_NAME);
      const cached = await cache?.match(url);
      if (cached) {
        const bytes = await cached.arrayBuffer();
        if (validGlb(bytes)) { this.stats.hits++; return bytes; }
        this.reload.add(url);
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
    const reload = this.reload.has(url);
    const response = await this.fetcher(url, {cache: reload ? 'reload' : 'default'});
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${url}`);
    const bytes = await response.arrayBuffer();
    if (!validGlb(bytes)) throw new Error('Invalid GLB response: ' + url);
    this.reload.delete(url);
    return bytes;
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
  if (bytes.byteLength < 12) return false;
  const header = new DataView(bytes);
  return header.getUint32(0, true) === 0x46546c67
    && header.getUint32(4, true) === 2
    && header.getUint32(8, true) === bytes.byteLength;
}

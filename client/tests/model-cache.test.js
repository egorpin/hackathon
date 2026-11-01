import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCache } from '../src/scene/model-cache.js';
const origin='https://game.test';
function glb(size=12) { const b=new Uint8Array(size); b.set([0x67,0x6c,0x54,0x46]); const view=new DataView(b.buffer); view.setUint32(4,2,true); view.setUint32(8,size,true); return b; }
function storage() { const items=new Map(); return {items, async open(){return {
  async match(k){return items.get(typeof k==='string'?k:k.url)?.clone();},
  async put(k,v){items.set(k,v.clone());}, async delete(k){return items.delete(typeof k==='string'?k:k.url);},
  async keys(){return [...items.keys()].map(url=>({url}));}
};}}; }
test('deduplicates concurrent requests, hits warm cache and replaces revisions',async()=>{
 const disk=storage(); let calls=0; const fetcher=async()=>{calls++; await new Promise(r=>setTimeout(r,5)); return new Response(glb());};
 const cold=new ModelCache({storage:disk,fetcher,origin}); await Promise.all([cold.get('drill','1'),cold.get('drill','1')]); assert.equal(calls,1);
 const warm=new ModelCache({storage:disk,fetcher,origin}); await warm.get('drill','1'); assert.equal(calls,1); assert.equal(warm.stats.hits,1);
 await warm.get('drill','2'); assert.equal(calls,2); assert.equal(disk.items.size,1); assert.match([...disk.items.keys()][0],/v=2$/);
});
test('storage errors and unversioned manifests fall back to network',async()=>{
 let calls=0; const fetcher=async()=>{calls++; return new Response(glb());};
 const cache=new ModelCache({storage:{open:async()=>{throw Error('unavailable');}},fetcher,origin});
 await cache.get('storage','1'); await cache.get('storage','1'); await cache.get('storage',null); assert.equal(calls,2);
 await assert.rejects(cache.get('secret','1'),/Invalid model/);
});
test('default browser fetch is called with the global receiver',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async function(){ assert.equal(this,globalThis); return new Response(glb()); };
 try { const cache=new ModelCache({storage:null,origin}); await cache.get('drill','1'); }
 finally { globalThis.fetch=original; }
});
test('discards corrupt bytes and failed downloads',async()=>{
 const disk=storage(); let calls=0; const cache=new ModelCache({storage:disk,origin,fetcher:async()=>{calls++; return calls===1?new Response('',{status:500}):new Response(glb());}});
 disk.items.set(`${origin}/assets/models/drill.glb?v=1`,new Response('bad'));
 await assert.rejects(cache.get('drill','1'),/500/); assert.equal(disk.items.size,0); await cache.get('drill','1'); assert.equal(disk.items.size,1); assert.equal(await cache.invalidate('drill','1'),true);
});
test('evicts oldest models at the byte limit',async()=>{
 const disk=storage(); const cache=new ModelCache({storage:disk,origin,fetcher:async()=>new Response(glb(8*1024*1024))});
 for(const name of ['drill','astronaut','storage','dome_base','rover']) await cache.get(name,'1');
 assert.equal(disk.items.size,4); assert.equal([...disk.items.keys()].some(x=>x.includes('drill.glb')),false);
});

test('memory fallback is bounded LRU, isolates buffers and removes older revisions',async()=>{
 let calls=0;
 const cache=new ModelCache({storage:null,origin,maxMemoryBytes:24,fetcher:async()=>{calls++;return new Response(glb());}});
 const first=await cache.get('drill','1'); new Uint8Array(first).fill(0);
 assert.equal(new DataView(await cache.get('drill','1')).getUint32(0,true),0x46546c67);
 await cache.get('storage','1'); await cache.get('drill','1'); await cache.get('rover','1');
 assert.equal(cache.memoryBytes,24); assert.equal(calls,3);
 await cache.get('storage','1'); assert.equal(calls,4);
 await cache.get('storage','2');
 assert.equal([...cache.memory.keys()].filter(k=>k.includes('storage')).length,1);
 cache.clearMemory(); assert.equal(cache.memoryBytes,0);
});

test('invalidated models bypass HTTP cache even when Cache Storage is unavailable',async()=>{
 const modes=[];
 const cache=new ModelCache({storage:null,origin,fetcher:async(_url,options)=>{modes.push(options.cache);return new Response(glb());}});
 await cache.get('drill','1'); assert.equal(await cache.invalidate('drill','1'),true);
 await cache.get('drill','1');
 assert.deepEqual(modes,['default','reload']);
});

test('invalid GLB lengths never enter either cache',async()=>{
 const disk=storage(); const broken=glb(); new DataView(broken.buffer).setUint32(8,100,true);
 const cache=new ModelCache({storage:disk,origin,fetcher:async()=>new Response(broken)});
 await assert.rejects(cache.get('drill','1'),/Invalid GLB/);
 assert.equal(disk.items.size,0); assert.equal(cache.memoryBytes,0);
});

test('clearing memory during download prevents late repopulation',async()=>{
 let finish;
 const cache=new ModelCache({storage:null,origin,fetcher:()=>new Promise(resolve=>{finish=resolve;})});
 const loading=cache.get('drill','1');
 await new Promise(resolve=>setTimeout(resolve,0));
 cache.clearMemory(); finish(new Response(glb())); await loading;
 assert.equal(cache.memoryBytes,0);
});

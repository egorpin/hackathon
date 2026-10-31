import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import assert from 'node:assert/strict';
import { GameClient } from '../src/net/client.js';
import { Runtime } from '../src/net/runtime.js';
import { Events } from '../src/net/events.js';
let input = '';
for await (const data of process.stdin) input += data;
const messages = JSON.parse(input);
class Socket {
  constructor() { this.readyState = 1; }
  send() {}
  close() {}
}
const transport = new GameClient({url:'ws://test/ws', WebSocketClass:Socket});
const events = new Events(), loaded = new Map();
const scene = { controls:{clear(){}}, reset(){loaded.clear();}, configure(){}, applyState(){},
  load(chunk){loaded.set(chunk.chunk_id, chunk);}, unload(id){loaded.delete(id);}, dispose(){} };
const runtime = new Runtime(transport, scene, events);
const notices=[];
events.on('notice', message=>notices.push(message));
let snapshots=0, deltas=0, chunks=0;
for (const message of messages) {
  if (message.type === 'session.ready') transport.connect();
  transport.receive(message);
  assert.deepEqual(notices, []);
  assert.ok(runtime.cache.used <= runtime.cache.total * .1);
  if (message.type === 'world.snapshot') {snapshots++; assert.equal(transport.ready,true);}
  if (message.type === 'world.delta') deltas++;
  if (message.type === 'chunk.load') {chunks++; assert.ok(loaded.has(message.payload.chunk_id));}
}
assert.ok(snapshots >= 2 && deltas > 0 && chunks > 0);
assert.equal(runtime.state.buildings.length, 3);
assert.ok(runtime.state.oxygen > 0);
runtime.dispose();
console.log(`PASS: browser Runtime accepted ${snapshots} snapshots, ${deltas} deltas, ${chunks} chunks without resync or byte mismatch`);

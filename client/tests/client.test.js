import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldCache, byteSize } from '../src/net/world-cache.js';
import { advance, tangent, vector, PlayerTrack } from '../src/scene/motion.js';
import { GameClient, socketURL } from '../src/net/client.js';

test('UTF-8 bytes, reservations and duplicate keys',()=>{
 const c=new WorldCache(); c.reset(1000);
 const value={name:'Марс'}; const bytes=byteSize(value);
 assert.equal(bytes,19); assert.ok(c.reserve('chunk:a',bytes)); assert.equal(c.stats().queuedBytes,bytes);
 assert.equal(c.reserve('chunk:a',bytes),false); assert.ok(c.commit('chunk:a',value));
 assert.equal(c.stats().queuedBytes,0); assert.equal(c.used,bytes);
});
test('predicted movement sweeps building collision discs on the sphere',()=>{
 const start=vector([0,30,0]), heading=vector([1,0,0]);
 const obstacle=advance(start,heading,{forward:1,right:0},1,1,30).position;
 const blocked=advance(start,heading,{forward:1,right:0},2,1,30,[[obstacle.toArray(),.2]]);
 assert.deepEqual(blocked.position.toArray(),start.toArray());
 const clear=advance(start,heading,{forward:1,right:0},1,1,30,[[vector([0,0,30]).toArray(),.2]]);
 assert.ok(clear.position.distanceTo(start)>0);
});
test('predicted movement can recover from an existing obstacle overlap',()=>{
 const center=vector([0,30,0]);
 const start=advance(center,vector([1,0,0]),{forward:1,right:0},1.4,1,30).position;
 const obstacle=[[center.toArray(),1.55]];
 const toward=advance(start,vector([-1,0,0]),{forward:1,right:0},.1,1,30,obstacle);
 assert.deepEqual(toward.position.toArray(),start.toArray());
 const away=advance(start,vector([1,0,0]),{forward:1,right:0},.1,1,30,obstacle);
 assert.ok(away.position.distanceTo(center)>start.distanceTo(center));
});
test('evicts loaded chunks only when needed for the hard limit; pending queue cannot be evicted',()=>{
 const c=new WorldCache(); c.reset(1000);
 c.put('chunk:a','a'.repeat(28)); c.reserve('chunk:b',30);
 assert.equal(c.entries.has('chunk:a'),true);
 assert.ok(c.reserve('chunk:c',60)); assert.equal(c.entries.has('chunk:a'),false);
 assert.equal(c.reserve('chunk:d',11),false); assert.equal(c.used,90);
});
test('repeated incoming state reservations preserve loaded terrain within the hard limit',()=>{
 const c=new WorldCache(); c.reset(10000);
 c.put('state','s'.repeat(298),{pinned:true});
 c.put('chunk:a','a'.repeat(348));
 c.put('chunk:b','b'.repeat(148));
 for(let i=0;i<200;i++){
  assert.ok(c.reserve('incoming:state',180,{pinned:true}));
  c.drop('incoming:state');
  assert.ok(c.entries.has('chunk:a') && c.entries.has('chunk:b'));
  assert.ok(c.used<=1000);
 }
});
test('wrong byte sizes and unsolicited chunks rejected',()=>{
 const c=new WorldCache(); c.reset(1000);
 assert.equal(c.commit('unknown',{}),false); c.reserve('chunk:a',5);
 assert.equal(c.commit('chunk:a',{large:'value'}),false); assert.equal(c.used,0);
});
test('shell/state pinned; hard limit includes incoming queue',()=>{
 const c=new WorldCache(); c.reset(1000); c.put('state','a'.repeat(58),{pinned:true});
 assert.equal(c.reserve('chunk:a',41),false); assert.ok(c.reserve('chunk:a',40)); assert.equal(c.used,100);
});
test('long loading sequence never exceeds ten percent',()=>{
 const c=new WorldCache(); c.reset(10000);
 c.put('state',{shell:{radius:100}},{pinned:true});
 for(let i=0;i<5000;i++){ const data={id:i,text:'x'.repeat(100)}; if(c.reserve('chunk:'+i,byteSize(data)))c.commit('chunk:'+i,data); assert.ok(c.used<=1000); }
});
test('continuous movement at both poles and equator preserves radius and tangent',()=>{
 for(const start of [[0,100,0],[0,-100,0],[100,0,0]]) {
  let position=vector(start),heading=vector([0,1,0]);
  for(let i=0;i<10000;i++){
   const next=advance(position,heading,{forward:1,right:.5},4,.05,100); position=next.position;heading=next.heading;
   assert.ok(Math.abs(position.length()-100)<1e-9);
   assert.ok(Math.abs(tangent(position,heading).forward.dot(position.clone().normalize()))<1e-9);
  }
 }
});
test('remote interpolation stays on sphere, clamps delayed packets',()=>{
 const track=new PlayerTrack(); track.push({position:[0,100,0]},0);track.push({position:[10,99.49874371,0]},100);
 assert.ok(Math.abs(track.sample(50,100).position.length()-100)<1e-9);
 assert.ok(track.sample(500,100).position.distanceTo(vector([10,99.49874371,0]))<1e-7);
});
test('socket URL follows page origin and TLS',()=>{
 assert.equal(socketURL({href:'https://mars.local:8000/',protocol:'https:'}),'wss://mars.local:8000/ws');
 assert.equal(socketURL({href:'http://192.168.1.10:8000/',protocol:'http:'}),'ws://192.168.1.10:8000/ws');
});
class Socket {
 constructor(){this.readyState=1;this.sent=[];}
 send(data){this.sent.push(JSON.parse(data));}
 close(){this.closed=true;}
}
test('snapshot gate, input sequence and revision gap resync',()=>{
 const c=new GameClient({url:'ws://test/ws',WebSocketClass:Socket});c.connect();c.input({axes:{}});
 assert.equal(c.socket.sent.length,0);
 c.receive({type:'world.snapshot',revision:5,payload:{last_input_seq:10}});
 c.input({move:[0,0,-1],flashlight:true,pitch:.4});assert.deepEqual(c.socket.sent[0].payload,{seq:11,move:[0,0,-1],flashlight:true,pitch:.4});
 c.receive({type:'world.delta',revision:7,payload:{players:[]}}); assert.equal(c.ready,false);assert.equal(c.socket.closed,true);c.close();
});
test('authenticated session opens the existing server transport',()=>{
 const c=new GameClient({url:'ws://test/ws',WebSocketClass:Socket});const statuses=[];
 c.on('status',status=>statuses.push(status));c.connect();
 c.receive({type:'session.ready',payload:{user_id:'user-1',world_id:'world-1',team_id:'team-1'}});
 assert.equal(c.ready,true);assert.equal(c.session.user_id,'user-1');
 assert.equal(statuses.at(-1),'connected');
 c.input({move:[0,0,1]});assert.equal(c.socket.sent.length,0);
 assert.throws(()=>c.command('building.place',{cell_id:'x'}),/состояния мира/);
 const color=c.command('player.color',{color:'#d97941'});
 assert.equal(c.socket.sent[0].request_id,color);
 const id=c.command('chat.send',{text:'hello'});
 assert.equal(c.socket.sent[1].request_id,id);c.close();
});
test('unconfirmed commands replay with original IDs only after snapshot',()=>{
 const c=new GameClient({url:'ws://test/ws',WebSocketClass:Socket});c.connect();
 c.receive({type:'world.snapshot',revision:1,payload:{}});
 const id=c.command('building.place',{cell_id:'x',building_type:'drill'});
 c.connect();assert.equal(c.socket.sent.length,0);
 c.receive({type:'world.snapshot',revision:2,payload:{}});
 assert.equal(c.socket.sent[0].request_id,id);
 c.receive({type:'action.result',request_id:id,payload:{ok:true}});
 assert.equal(c.pending.size,0);c.close();
});
test('a new expedition drops stale gameplay commands before reconnect replay but preserves chat',()=>{
 const c=new GameClient({url:'ws://test/ws',WebSocketClass:Socket});c.connect();
 c.receive({type:'world.snapshot',revision:1,payload:{generation:0}});
 c.command('building.place',{cell_id:'x',building_type:'drill'});
 const chat=c.command('chat.send',{text:'hello'});
 c.connect();c.receive({type:'session.ready',payload:{user_id:'u',world_id:'w',team_id:'t'}});
 c.receive({type:'world.snapshot',revision:3,payload:{generation:1}});
 assert.deepEqual(c.socket.sent.map(message=>message.request_id),[chat]);
 assert.deepEqual([...c.pending.keys()],[chat]);c.close();
});

test('drill requests require deposits and changing building type refreshes preview', async () => {
 const { Runtime } = await import('../src/net/runtime.js');
 const { Events } = await import('../src/net/events.js');
 const events = new Events(), transport = new Events(), sent = [];
 transport.command = (type, payload) => sent.push({type, payload});
 const scene = {selected:{cell_id:'ground',resource:null}, select(cell){this.refreshed = cell;}};
 new Runtime(transport,scene,events);
 events.emit('build.request'); assert.equal(sent.length,0);
 scene.selected = {cell_id:'iron',resource:'iron'};
 events.emit('build.request'); assert.equal(sent.length,0,'no implicit drill before choosing a slot');
 events.emit('build.type','drill');
 scene.selected = {cell_id:'ground',resource:null};
 events.emit('build.request'); assert.equal(sent.length,0);
 for (const resource of ['water','iron','sulfur','copper']) {
  scene.selected = {cell_id:resource,resource}; events.emit('build.request');
 }
 assert.equal(sent.length,4);
 scene.selected = {cell_id:'ground',resource:null};
 events.emit('build.type','warehouse');
 assert.equal(scene.buildType,'warehouse'); assert.equal(scene.refreshed,scene.selected);
 events.emit('build.request'); assert.equal(sent.at(-1).payload.building_type,'warehouse');
 const count=sent.length;
 events.emit('build.type',null);events.emit('build.request');
 assert.equal(sent.length,count,'cancelled selection cannot place buildings');
});

test('server errors emit readable text once, preserving the raw message separately',()=>{
 const c=new GameClient({url:'ws://test/ws',WebSocketClass:Socket});c.connect();
 c.receive({type:'session.ready',payload:{user_id:'u',world_id:'w',team_id:'t'}});
 const errors=[], messages=[];
 c.on('error',error=>errors.push(error));c.on('message',message=>messages.push(message));
 const message={type:'error',payload:{code:'WORLD_UNAVAILABLE',message:'World is full'}};
 c.receive(message);
 assert.deepEqual(errors,['World is full']);
 assert.deepEqual(messages,[message]);assert.equal(c.ready,false);assert.equal(c.worldUnavailableReason,'World is full');c.close();
});

test('telemetry answers server ping without waiting for a world snapshot',()=>{
 const c=new GameClient({url:'ws://test/ws',WebSocketClass:Socket});c.connect();
 c.receive({type:'telemetry.ping',payload:{nonce:'unique-probe'}});
 assert.deepEqual(c.socket.sent,[{type:'telemetry.pong',payload:{nonce:'unique-probe'}}]);
 assert.equal(c.pending.size,0);c.close();
});


test('remote position buffer bounds burst packets and discards old movement',()=>{
 const track=new PlayerTrack();
 for(let i=0;i<1000;i++)track.push({position:[0,100,i/1000]},i);
 assert.ok(track.samples.length<=8);
 track.push({position:[0,100,1]},5000);
 assert.equal(track.samples.length,2);
 assert.equal(track.samples.at(-1).time,5000);
});

test('chunk bookkeeping is released with active data and never enters command history',async()=>{
 const {Runtime}=await import('../src/net/runtime.js'); const {Events}=await import('../src/net/events.js');
 const transport=new Events(),sent=[];transport.ready=true;
 transport.command=(type,payload)=>{sent.push({type,payload});return 'chunk-request';};
 const runtime=new Runtime(transport,{unload(){}},new Events());runtime.cache.reset(10000);
 runtime.offer({chunk_id:'a',byte_size:20,offer_id:3});
 assert.equal(runtime.pendingCommands.size,0);assert.equal(runtime.chunkOffers.size,1);
 transport.emit('chunk.unload',{chunk_id:'a'});
 assert.equal(runtime.chunkOffers.size,0);assert.equal(runtime.cache.used,0);
 assert.equal(sent.length,1,'server unload does not echo release');
 runtime.offer({chunk_id:'huge',byte_size:1001,offer_id:4});
 assert.equal(runtime.chunkOffers.size,0);assert.equal(sent.at(-1).type,'chunk.release');
});

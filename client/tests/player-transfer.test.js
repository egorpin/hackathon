import test from 'node:test';
import assert from 'node:assert/strict';
import { nearbyRecipients, givePayload, PlayerTransfer } from '../src/ui/player-transfer.js';

const state=()=>({stage:'running',self_id:'me',team_id:'team',world:{radius:30},
  config:{interaction_distance:4.5,inventory_capacity:50},inventory:{iron:10},players:[
    {player_id:'me',team_id:'team',position:[0,30,0]},
    {player_id:'friend',team_id:'team',position:[1,30,0]},
    {player_id:'enemy',team_id:'other',position:[1,30,0]},
    {player_id:'far',team_id:'team',position:[30,0,0]},
    {player_id:'unplaced',team_id:'team',position:null},
  ]});

test('only nearby teammates other than self can receive items',()=>{
  assert.deepEqual(nearbyRecipients(state()).map(p=>p.player_id),['friend']);
  assert.deepEqual(nearbyRecipients({...state(),stage:'lobby'}),[]);
  assert.deepEqual(nearbyRecipients(null),[]);
});

test('transfer validates stock, resource, integer amount and current range',()=>{
  const s=state();
  assert.deepEqual(givePayload(s,'friend','iron',10),{recipient_player_id:'friend',resource:'iron',amount:10});
  for(const amount of [0,-1,1.5,NaN,Infinity,11,51])assert.equal(givePayload(s,'friend','iron',amount),null);
  for(const recipient of ['me','enemy','far','unplaced','missing'])assert.equal(givePayload(s,recipient,'iron',1),null);
  assert.equal(givePayload(s,'friend','oxygen',1),null);
  s.players[1].position=[30,0,0];
  assert.equal(givePayload(s,'friend','iron',1),null);
});

test('submit emits one authoritative intention and closes; stale targets emit nothing',()=>{
  const commands=[];const s=state();let closed=0;
  const ui={connected:true,state:s,fields:{recipient:{value:'friend'},resource:{value:'iron'},amount:{value:'3'}},
    payload:PlayerTransfer.prototype.payload,events:{emit:(type,payload)=>commands.push({type,payload})},panel:{close:()=>closed++},resume(){}};
  PlayerTransfer.prototype.send.call(ui);
  assert.deepEqual(commands,[{type:'command',payload:{type:'resource.give',payload:{recipient_player_id:'friend',resource:'iron',amount:3}}}]);
  assert.equal(closed,1);
  s.players[1].position=[30,0,0];PlayerTransfer.prototype.send.call(ui);
  ui.connected=false;PlayerTransfer.prototype.send.call(ui);
  assert.equal(commands.length,1);
});

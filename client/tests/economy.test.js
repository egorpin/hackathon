import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeFor, formatResources, missingResources, canAfford, transferPlan, buildingTransfer } from '../src/ui/economy.js';
import { Runtime } from '../src/net/runtime.js';
import { Events } from '../src/net/events.js';
import { byteSize } from '../src/net/world-cache.js';

test('construction uses every ingredient in shared storage, never personal ore',()=>{
  const state={inventory:{ore:999},team_storage:{iron:15,sulfur:4},config:{recipes:{oxygen_generator:{iron:15,sulfur:5}}}};
  assert.equal(canAfford(state,'oxygen_generator'),false);
  assert.deepEqual(missingResources(state,'oxygen_generator'),{sulfur:1});
  state.team_storage.sulfur=5;
  assert.equal(canAfford(state,'oxygen_generator'),true);
  assert.equal(canAfford({...state,team_storage:undefined},'oxygen_generator'),false);
  assert.equal(recipeFor({config:{recipes:{drill:5}}},'drill'),null);
  assert.equal(canAfford(state,'unknown'),false);
  assert.equal(formatResources(state.config.recipes.oxygen_generator,true),'15 Fe + 5 S');
});

test('accepted state event merges partial collections and removal before updating HUD',()=>{
  const transport=new Events(),events=new Events(),states=[];
  const scene={applyState(delta){this.delta=delta;}};
  const runtime=new Runtime(transport,scene,events);
  runtime.cache.reset(100000);
  runtime.state={players:[{player_id:'me'},{player_id:'peer'}], buildings:[{building_id:'drill'},{building_id:'warehouse'}],team_storage:{iron:20},config:{storage_capacity:500}};
  runtime.cache.put('state',runtime.state,{pinned:true});
  events.on('world.state',state=>states.push(state));
  const delta={players:[{player_id:'me',position:[1,2,3]}],buildings:[],removed_buildings:['warehouse'],team_storage:{iron:30},config:{storage_capacity:300},energy:{production:10,consumption:20,efficiency:.5},oxygen_percent:.1};
  runtime.cache.reserve('incoming:state',byteSize(delta),{pinned:true});
  runtime.delta(delta);
  assert.equal(states.length,1);
  assert.equal(states[0].players.length,2);
  assert.deepEqual(states[0].buildings,[{building_id:'drill'}]);
  assert.equal(states[0].team_storage.iron,30);
  assert.equal(states[0].config.storage_capacity,300);
  assert.equal(states[0].oxygen_percent,.1);
  assert.deepEqual(states[0].energy,{production:10,consumption:20,efficiency:.5});
});

test('remove and respawn commands cross runtime allowlist unchanged',()=>{
  const transport=new Events(),events=new Events(),sent=[];
  transport.command=(type,payload)=>{sent.push({type,payload});return 'request-id';};
  const runtime=new Runtime(transport,{},events);
  assert.equal(runtime.command('building.remove',{building_id:'team-building'}),'request-id');
  runtime.command('player.respawn',{});
  assert.deepEqual(sent,[{type:'building.remove',payload:{building_id:'team-building'}},{type:'player.respawn',payload:{}}]);
});

test('pickup and unload budget total capacity and generators accept only water',()=>{
  assert.deepEqual(transferPlan({iron:40,water:30},{copper:20},50),[{resource:'iron',amount:30}]);
  assert.deepEqual(transferPlan({water:100},{},300),[{resource:'water',amount:50}]);
  const state={inventory:{iron:5,water:10},team_storage:{iron:299},config:{inventory_capacity:50,storage_capacity:300,building_capacity:50}};
  assert.deepEqual(buildingTransfer(state,{building_type:'drill',stock:{copper:50}}),{type:'resource.pickup',items:[{resource:'copper',amount:35}]});
  assert.deepEqual(buildingTransfer(state,{building_type:'warehouse'}),{type:'resource.deposit',items:[{resource:'iron',amount:1}]});
  assert.deepEqual(buildingTransfer(state,{building_type:'oxygen_generator',stock:{water:47}}),{type:'resource.deposit',items:[{resource:'water',amount:3}]});
  assert.deepEqual(buildingTransfer(state,{building_type:'oxygen_generator',stock:{water:50}}).items,[]);
  assert.deepEqual(buildingTransfer(state,{building_type:'dome_base'}).items,[]);
});

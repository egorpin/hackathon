import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSound, sceneSoundLevels } from '../src/audio/soundscape.js';
test('maps confirmed player actions to sounds',()=>{assert.equal(actionSound({payload:{ok:true},command:{type:'building.place'}}),'construct');assert.equal(actionSound({payload:{ok:true},command:{type:'resource.pickup'}}),'pickup');assert.equal(actionSound({payload:{ok:true},command:{type:'rover.survey'}}),'scan');assert.equal(actionSound({payload:{ok:false},command:{type:'building.place'}}),'error');});
test('keeps machinery sound bounded by the nearest active source',()=>{const levels=sceneSoundLevels({robots:30,rover:.2,buildings:[{type:'drill',active:true,gain:.04},{type:'drill',active:true,gain:.12},{type:'oxygen_generator',active:false,gain:.5},{type:'wind_turbine',active:true,gain:.09}]});assert.equal(levels.get('drill'),.12);assert.equal(levels.get('wind_turbine'),.09);assert.equal(levels.get('oxygen_generator'),undefined);assert.equal(levels.has('robot'),false);});
import { Soundscape } from '../src/audio/soundscape.js';
import { makeSamples } from '../src/audio/sound-buffers.js';
test('footsteps follow travel and stop while stationary, airborne or in menus',()=>{
 const s=Object.create(Soundscape.prototype),sounds=[];s.play=kind=>sounds.push(kind);
 for(let i=0;i<=20;i++)s.motion({position:[i/5,30,0],active:true});
 assert.ok(sounds.length>=2);
 const count=sounds.length;
 for(let i=0;i<100;i++)s.motion({position:[4,30,0],active:true});
 assert.equal(sounds.length,count);
 s.motion({position:[5,30,0],active:true,altitude:1});
 s.motion({position:[6,30,0],active:false});
 assert.equal(sounds.length,count);
});
test('robots beep once per 20 seconds and never create a continuous loop',()=>{
 const s=Object.create(Soundscape.prototype),sounds=[];let time=0;
 Object.assign(s,{unlocked:true,loops:new Map(),now:()=>time,play:kind=>sounds.push(kind)});
 s.updateScene({robots:9});
 for(time=1;time<20;time++)s.updateScene({robots:9});
 assert.equal(sounds.length,0);
 s.updateScene({robots:9});assert.deepEqual(sounds,['robot']);
 time=39;s.updateScene({robots:9});assert.equal(sounds.length,1);
 time=40;s.updateScene({robots:9});assert.equal(sounds.length,2);
 s.updateScene({});time=80;s.updateScene({robots:9});assert.equal(sounds.length,2);
});
test('sound samples are audible, bounded and machinery has distinct waveforms',()=>{
 const buffers=['step','hammer','drill','oxygen_generator'].map(kind=>makeSamples(kind));
 for(const b of buffers){
  let peak=0,power=0;
  for(const x of b){assert.ok(Number.isFinite(x));peak=Math.max(peak,Math.abs(x));power+=x*x;}
  assert.ok(peak<1&&Math.sqrt(power/b.length)>.01);
 }
 assert.notDeepEqual(buffers[2],buffers[3]);
});

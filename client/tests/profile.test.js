import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultProfile,avatarURL,loadProfile,saveProfile,normalizeProfile,suitColor} from '../src/ui/profile.js';
test('avatars are stable per account and differ between accounts',()=>{
 const a=avatarURL('a',defaultProfile('a')),b=avatarURL('b',defaultProfile('b'));
 assert.equal(a,avatarURL('a',defaultProfile('a')));assert.notEqual(a,b);
});
test('profile storage isolates users and ignores corrupt data',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 saveProfile('a',{...defaultProfile('a'),callsign:'Pilot A'},storage);
 assert.equal(loadProfile('a',storage).callsign,'Pilot A');assert.equal(loadProfile('b',storage).callsign,'');
 assert.equal(loadProfile('a',{getItem(){throw Error();}}).callsign,'');
 assert.equal(normalizeProfile({color:999,callsign:123},'a').color,defaultProfile('a').color);
});
test('avatar palette maps to server-approved astronaut suit colors',()=>{
 assert.equal(suitColor({color:0}),'#ff6b4a');
 assert.equal(suitColor({color:5}),'#42b8ff');
 assert.equal(suitColor({color:999}),'#ff6b4a');
});

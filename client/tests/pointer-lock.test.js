import test from 'node:test';
import assert from 'node:assert/strict';
import { restorePointerLock } from '../src/ui/pointer-lock.js';

test('closing gameplay dialogs requests pointer lock immediately and coalesces queued close events',async()=>{
  const old=globalThis.document;let modal=false,calls=0,finish;
  globalThis.document={querySelector:()=>modal,pointerLockElement:null};
  const scene={enabled:true,stage:'running',controls:{mode:'first',suspended:true,clear(){},canvas:{requestPointerLock(){calls++;return new Promise(resolve=>{finish=resolve;});}}}};
  try {
    restorePointerLock(scene);assert.equal(calls,1);assert.equal(scene.controls.suspended,false);
    restorePointerLock(scene);assert.equal(calls,1);
    finish();await new Promise(resolve=>setImmediate(resolve));
    modal=true;restorePointerLock(scene);assert.equal(calls,1);
    modal=false;scene.controls.mode='top';restorePointerLock(scene);assert.equal(calls,1);
    scene.controls.mode='first';scene.enabled=false;restorePointerLock(scene);assert.equal(calls,1);
  }finally{globalThis.document=old;}
});

test('pointer lock handles legacy void results and browser rejection without throwing',async()=>{
  const old=globalThis.document;globalThis.document={querySelector:()=>null};
  const scene={enabled:true,controls:{mode:'first',clear(){},canvas:{requestPointerLock(){}}}};
  try {
    assert.doesNotThrow(()=>restorePointerLock(scene));await new Promise(resolve=>setImmediate(resolve));
    scene.controls.canvas.requestPointerLock=()=>Promise.reject(new Error('activation required'));
    assert.doesNotThrow(()=>restorePointerLock(scene));await new Promise(resolve=>setImmediate(resolve));
  }finally{globalThis.document=old;}
});

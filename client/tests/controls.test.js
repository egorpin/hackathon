import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controls } from '../src/scene/controls.js';

test('planet drag, wheel and arrows orbit without changing player heading; overlays suspend controls',()=>{
  const saved={window:globalThis.window,document:globalThis.document};
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  const canvas=new EventTarget(), emitted=[];
  const controls=new Controls(canvas,{emit:(...args)=>emitted.push(args)});controls.mode='top';
  const fire=(target,type,props={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,props);target.dispatchEvent(event);return event;};
  try {
    assert.equal(fire(canvas,'wheel',{deltaY:200,deltaMode:0}).defaultPrevented,true);
    assert.deepEqual(emitted.pop(),['camera.zoom',.5]);
    fire(canvas,'mousedown',{button:0,clientX:100,clientY:100});
    fire(document,'mousemove',{clientX:200,clientY:150});
    assert.deepEqual(emitted.pop(),['camera.orbit',{x:.8,y:.4}]);
    fire(document,'mouseup');fire(canvas,'click');assert.equal(emitted.length,0);
    controls.keys.add('ArrowRight');controls.axes(1);
    assert.deepEqual(emitted.pop(),['camera.orbit',{x:3,y:0}]);assert.equal(controls.yaw,0);
    controls.suspended=true;controls.axes(1);fire(canvas,'wheel',{deltaY:200});assert.equal(emitted.length,0);
    controls.suspended=false;controls.mode='first';
    assert.equal(fire(canvas,'wheel',{deltaY:200}).defaultPrevented,false);
    controls.axes(1);assert.equal(controls.yaw,-1.5);
  } finally {controls.dispose();globalThis.window=saved.window;globalThis.document=saved.document;}
});

test('building shortcuts require active gameplay and ignore repeat and modifier keys',()=>{
  const saved={window:globalThis.window,document:globalThis.document};
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  const emitted=[],controls=new Controls(new EventTarget(),{emit:(...args)=>emitted.push(args)});
  const key=(code,extra={})=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{code,...extra});window.dispatchEvent(event);return event;};
  try {
    assert.equal(key('Digit1').defaultPrevented,true);
    assert.deepEqual(emitted.pop(),['build.choose','drill']);
    key('Numpad4');assert.deepEqual(emitted.pop(),['build.choose','dome_base']);
    key('Digit5');key('Digit1',{repeat:true});key('Digit2',{ctrlKey:true});
    assert.equal(emitted.length,0);
    controls.suspended=true;key('Digit3');key('KeyB');key('Escape');assert.equal(emitted.length,0);
    controls.suspended=false;key('Escape');assert.deepEqual(emitted.pop(),['build.cancel']);
  } finally {controls.dispose();globalThis.window=saved.window;globalThis.document=saved.document;}
});

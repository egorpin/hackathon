import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOpenTab, moveLocalFile, normalizeOpenTabs } from '../src/ui/local-files.js';

test('open tabs migrate old file lists and discard deleted or duplicate IDs',()=>{
  const files=[{id:'readme'},{id:'mission'},{id:'notes'}];
  assert.deepEqual(normalizeOpenTabs(files,null),['readme','mission','notes']);
  assert.deepEqual(normalizeOpenTabs(files,['notes','missing','notes','mission']),['notes','mission']);
  assert.deepEqual(normalizeOpenTabs(files,[]),[]);
});

test('closing a tab leaves the file intact and selects its right neighbor or previous tab',()=>{
  const files=[{id:'readme'},{id:'one',code:'wait(1)'},{id:'two',code:'wait(2)'}];
  const closed=closeOpenTab(files.map(file=>file.id),'one');
  assert.deepEqual(closed,{openTabs:['readme','two'],selected:'two'});
  assert.deepEqual(files[1],{id:'one',code:'wait(1)'});
  assert.deepEqual(closeOpenTab(['readme','one'],'one'),{openTabs:['readme'],selected:'readme'});
  assert.deepEqual(closeOpenTab(['readme'],'readme'),{openTabs:[],selected:null});
});

test('moving files requires an existing ID and folder and leaves read-only files in place',()=>{
  const files=[{id:'mission',folder:'Программы'},{id:'readme',folder:'Программы',readOnly:true}];
  const folders=['Программы','Маршруты'];
  assert.equal(moveLocalFile(files,folders,'mission','Маршруты'),true);
  assert.equal(files[0].folder,'Маршруты');
  assert.equal(moveLocalFile(files,folders,'readme','Маршруты'),false);
  assert.equal(files[1].folder,'Программы');
  assert.equal(moveLocalFile(files,folders,'missing','Маршруты'),false);
  assert.equal(moveLocalFile(files,folders,'mission','Новая папка'),false);
});

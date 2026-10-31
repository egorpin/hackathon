import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VISUAL_OPTIONS, updateVisualOptions } from '../src/scene/visual-options.js';

test('effect patches preserve unrelated settings and can restore disabled effects', () => {
  const off = updateVisualOptions(DEFAULT_VISUAL_OPTIONS, {rocks:false,dust:false,stars:false});
  assert.equal(off.resourceDeposits,true);
  assert.equal(off.dust,false);
  assert.equal(DEFAULT_VISUAL_OPTIONS.dust,true);
  assert.equal(updateVisualOptions(off,{dust:true}).dust,true);
  assert.equal(updateVisualOptions(off,{dust:true}).rocks,false);
});

test('effect patches accept only known boolean options', () => {
  assert.deepEqual(updateVisualOptions(DEFAULT_VISUAL_OPTIONS,{dust:'false',unknown:false}),DEFAULT_VISUAL_OPTIONS);
  assert.deepEqual(updateVisualOptions(DEFAULT_VISUAL_OPTIONS,null),DEFAULT_VISUAL_OPTIONS);
});

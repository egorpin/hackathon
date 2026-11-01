import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenSpeech, cleanSpeech, speechKeyAction } from '../src/ui/player-speech.js';

const scene = { enabled: true, stage: 'running', controls: { suspended: false } };
const key = (code, extra = {}) => ({ code, key: code === 'KeyT' ? 't' : code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, target: null, ...extra });

test('T opens speech only in active gameplay and not while typing in another field', () => {
  assert.equal(canOpenSpeech(key('KeyT'), scene, false), true);
  assert.equal(canOpenSpeech(key('KeyT'), scene, true), false);
  assert.equal(canOpenSpeech(key('KeyT', {repeat:true}), scene, false), false);
  assert.equal(canOpenSpeech(key('KeyT', {target:{closest:()=>({})}}), scene, false), false);
  assert.equal(canOpenSpeech(key('KeyT'), {...scene, controls:{suspended:true}}, false), false);
  assert.equal(canOpenSpeech(key('KeyT'), {...scene, stage:'lobby'}, false), false);
  assert.equal(canOpenSpeech(key('KeyE'), scene, false), false);
});

test('speech input sends on Enter, cancels on Escape and preserves Shift+Enter', () => {
  assert.equal(speechKeyAction(key('Enter')), 'send');
  assert.equal(speechKeyAction(key('Escape')), 'cancel');
  assert.equal(speechKeyAction(key('Enter', {shiftKey:true})), null);
  assert.equal(speechKeyAction(key('Enter', {isComposing:true})), null);
});

test('speech is normalized, strips control characters and caps at 120 characters', () => {
  assert.equal(cleanSpeech('  hello\u0000\nworld  '), 'helloworld');
  assert.equal(cleanSpeech('  e\u0301  '), 'é');
  assert.equal(cleanSpeech('x'.repeat(130)).length, 120);
});

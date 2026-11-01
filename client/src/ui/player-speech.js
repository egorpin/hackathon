import { restorePointerLock } from './pointer-lock.js';

const MAX_SPEECH_LENGTH = 120;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

export function cleanSpeech(value) {
  return String(value ?? '').normalize('NFC').replace(CONTROL_CHARS, '').trim().slice(0, MAX_SPEECH_LENGTH);
}

export function canOpenSpeech(event, scene, isOpen) {
  return event.code === 'KeyT' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
    && !isOpen && !scene.controls.suspended && scene.enabled && scene.stage === 'running'
    && !event.target?.closest?.('input,textarea,select,[contenteditable=true]');
}

export function speechKeyAction(event) {
  if (event.key === 'Escape') return 'cancel';
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) return 'send';
  return null;
}

export class PlayerSpeech {
  constructor({ events, scene, target = document }) {
    this.events = events;
    this.scene = scene;
    this.target = target;
    this.abort = new AbortController();
    this.previousSuspended = false;
    this.root = document.createElement('section');
    this.root.id = 'player-speech';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Сообщение игрокам');
    this.root.innerHTML = '<form><label for="player-speech-input">Сообщение игрокам</label><textarea id="player-speech-input" maxlength="120" rows="2" placeholder="Напишите короткое сообщение…"></textarea><div><span>Enter · отправить　 Esc · отмена</span><button type="submit">Отправить</button></div></form>';
    target.querySelector('main')?.append(this.root);
    this.form = this.root.querySelector('form');
    this.input = this.root.querySelector('textarea');
    const signal = this.abort.signal;
    window.addEventListener('keydown', event => {
      if (!canOpenSpeech(event, this.scene, !this.root.hidden)) return;
      event.preventDefault();
      this.open();
    }, { signal });
    this.input.addEventListener('keydown', event => {
      const action = speechKeyAction(event);
      if (action === 'cancel') { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (action === 'send') { event.preventDefault(); event.stopPropagation(); this.send(); }
    }, { signal });
    this.form.addEventListener('submit', event => { event.preventDefault(); this.send(); }, { signal });
    this.unsubs = [events.on('connection.status', status => { if (status !== 'connected') this.close({restore:false}); }), events.on('world.stage', stage => { if (stage !== 'running') this.close({restore:false}); })];
  }
  open() {
    if (!this.root.isConnected) return;
    this.previousSuspended = this.scene.controls.suspended;
    this.scene.controls.clear();
    this.scene.controls.suspended = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.hidden = false;
    this.input.value = '';
    this.input.focus();
  }
  close({ restore = true } = {}) {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.scene.controls.clear();
    this.scene.controls.suspended = this.previousSuspended;
    if (restore && !this.previousSuspended) restorePointerLock(this.scene);
  }
  send() {
    const text = cleanSpeech(this.input.value);
    if (!text) { this.close(); return; }
    this.events.emit('command', { type: 'chat.send', payload: { text } });
    this.close();
  }
  dispose() { this.close({restore:false}); this.abort.abort(); this.unsubs.forEach(unsub => unsub()); this.root.remove(); }
}

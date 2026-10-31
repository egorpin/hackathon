import { Events } from './events.js';

export function socketURL(location, path = '/ws') {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export class GameClient extends Events {
  constructor({ url = socketURL(window.location), WebSocketClass = WebSocket } = {}) {
    super(); this.url = url; this.Socket = WebSocketClass;
    this.seq = 0; this.revision = null; this.attempt = 0; this.pending = new Map();
    this.ready = false; this.stopped = true; this.session = null;
  }
  connect() {
    this.stopped = false; this.ready = false;
    this.emit('status', 'connecting');
    const socket = this.socket = new this.Socket(this.url);
    socket.onopen = () => { this.emit('status', 'syncing'); };
    socket.onmessage = ({ data }) => {
      if (socket !== this.socket) return;
      try { this.receive(JSON.parse(data)); }
      catch (error) { this.emit('error', error.message); this.resync(); }
    };
    socket.onerror = () => this.emit('error', 'Соединение WebSocket недоступно.');
    socket.onclose = ({ code }) => {
      if (socket !== this.socket) return;
      this.ready = false; this.revision = null;
      if (this.stopped) return;
      if (code === 4401 || code === 4403 || code === 1008) {
        this.emit('status', 'unauthorized'); return;
      }
      this.emit('status', 'reconnecting');
      this.timer = setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** this.attempt++) + Math.random() * 250);
    };
  }
  resync() {
    this.ready = false;
    // A fresh connection requests a full snapshot; no speculative delta repair.
    this.socket?.close(4000, 'snapshot required');
  }
  receive(message) {
    const { type, payload, revision, request_id } = message;
    if (typeof type !== 'string' || !payload) throw new Error('Некорректное сообщение сервера');
    if (type === 'session.ready') {
      if (!['user_id','world_id','team_id'].every(key => typeof payload[key] === 'string')) {
        throw new Error('Сервер вернул некорректную сессию');
      }
      this.session = payload; this.ready = true; this.attempt = 0;
      this.emit(type, payload); this.emit('status', 'connected');
      // Chat is available as soon as the authenticated transport is ready.
      // Gameplay commands continue to wait for an authoritative snapshot.
      for (const command of this.pending.values()) if (command.type === 'chat.send') this.send(command);
      return;
    }
    if (type === 'world.offer') { this.emit(type, payload); return; }
    if (type === 'world.snapshot') {
      if (!Number.isSafeInteger(revision)) throw new Error('Snapshot без revision');
      this.revision = revision; this.seq = Math.max(this.seq, payload.last_input_seq || 0);
      this.ready = true; this.attempt = 0;
      this.emit(type, payload);
      if (!this.ready) return;
      this.emit('status', 'connected');
      for (const command of this.pending.values()) this.send(command);
      return;
    }
    if (type === 'world.delta') {
      if (!this.ready) return;
      if (!Number.isSafeInteger(revision) || revision <= this.revision) { this.resync(); return; }
      if (revision !== this.revision + 1) { this.resync(); return; }
      this.revision = revision;
    } else if (!this.ready) return;
    if (type === 'action.result') this.pending.delete(request_id);
    this.emit(type, payload);
    this.emit('message', message);
  }
  send(message) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  input(input) {
    if (!this.ready) return;
    this.send({ type: 'player.input', payload: { seq: ++this.seq, ...input } });
  }
  command(type, payload) {
    if (!this.ready) throw new Error('Дождитесь синхронизации с сервером.');
    if (this.pending.size >= 64) throw new Error('Слишком много неподтверждённых действий.');
    const request_id = globalThis.crypto?.randomUUID?.() || uuid();
    const message = { type, request_id, payload: structuredClone(payload) };
    if (!type.startsWith('chunk.')) this.pending.set(request_id, message);
    this.send(message);
    return request_id;
  }
  close() {
    this.stopped = true; this.ready = false;
    clearTimeout(this.timer); this.socket?.close(); this.pending.clear();
  }
}
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}

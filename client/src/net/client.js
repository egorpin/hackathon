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
    this.ready = false; this.stopped = true; this.session = null; this.generation = null;
  }
  connect() {
    clearTimeout(this.timer);
    clearInterval(this.telemetryTimer);
    this.worldUnavailableReason = null;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    this.revision = null;
    this.stopped = false; this.ready = false;
    this.emit('status', 'connecting');
    const socket = this.socket = new this.Socket(this.url);
    socket.onopen = () => {
      this.emit('status', 'syncing');
      this.telemetryTimer = setInterval(() => {
        const stats = this.performanceStats || {};
        this.send({type: 'telemetry.report', payload: {
          fps: stats.fps ?? null, frameP95: stats.frameP95 ?? null,
          drawCalls: stats.drawCalls ?? null, triangles: stats.triangles ?? null,
          hidden: globalThis.document?.hidden ?? false,
        }});
      }, 2000);
    };
    socket.onmessage = ({ data }) => {
      if (socket !== this.socket) return;
      try { this.receive(JSON.parse(data)); }
      catch (error) { this.emit('error', error.message); this.resync(); }
    };
    socket.onerror = () => this.emit('error', 'Соединение WebSocket недоступно.');
    socket.onclose = ({ code }) => {
      if (socket !== this.socket) return;
      clearInterval(this.telemetryTimer);
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
    if (type === 'telemetry.ping') {
      this.send({type: 'telemetry.pong', payload: {nonce: payload.nonce}}); return;
    }
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
      this.observeGeneration(payload.generation);
      this.revision = revision; this.seq = Math.max(this.seq, payload.last_input_seq || 0);
      this.ready = true; this.attempt = 0;
      this.emit(type, payload);
      if (!this.ready) return;
      this.emit('status', 'connected');
      for (const command of this.pending.values()) if (command.type !== 'chat.send') this.send(command);
      return;
    }
    if (type === 'lobby.state' && payload.stage === 'lobby') {
      // Commands from the previous expedition must never be replayed into a new one.
      for (const [id, command] of this.pending) if (command.type !== 'chat.send') this.pending.delete(id);
    }
    if (type === 'world.delta') {
      if (!this.ready) return;
      if (!Number.isSafeInteger(revision) || revision <= this.revision) { this.resync(); return; }
      if (revision !== this.revision + 1) { this.resync(); return; }
      this.observeGeneration(payload.generation);
      this.revision = revision;
    } else if (!this.ready) return;
    if (type === 'action.result' || type === 'error') this.pending.delete(request_id);
    if (type === 'error') this.emit('error', payload.message || payload.code || 'Неизвестная ошибка сервера');
    else this.emit(type, payload);
    if (type === 'error' && payload.code === 'WORLD_UNAVAILABLE') {
      this.worldUnavailableReason = payload.message;
      this.ready = false; this.emit('status', 'world_unavailable');
    }
    this.emit('message', message);
  }
  send(message) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  observeGeneration(generation) {
    if (!Number.isSafeInteger(generation)) return;
    if (this.generation !== null && generation !== this.generation) {
      for (const [id, command] of this.pending) if (command.type !== 'chat.send') this.pending.delete(id);
    }
    this.generation = generation;
  }
  input(input) {
    if (!this.ready || this.revision === null) return;
    const payload = { seq: ++this.seq, move: input.move };
    for (const key of ['heading','jump','running']) if (input[key] !== undefined) payload[key] = input[key];
    this.send({ type: 'player.input', payload });
  }
  command(type, payload) {
    if (!this.ready) throw new Error('Дождитесь синхронизации с сервером.');
    if (type !== 'chat.send' && this.revision === null) throw new Error('Дождитесь состояния мира.');
    if (this.pending.size >= 64) throw new Error('Слишком много неподтверждённых действий.');
    const request_id = globalThis.crypto?.randomUUID?.() || uuid();
    const message = { type, request_id, payload: structuredClone(payload) };
    if (!type.startsWith('chunk.')) this.pending.set(request_id, message);
    this.send(message);
    return request_id;
  }
  close() {
    this.stopped = true; this.ready = false;
    clearTimeout(this.timer); clearInterval(this.telemetryTimer); this.socket?.close(); this.pending.clear();
  }
}
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}

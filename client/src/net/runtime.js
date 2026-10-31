import { WorldCache } from './world-cache.js';
export class Runtime {
  constructor(transport, scene, events) {
    this.transport = transport; this.scene = scene; this.events = events; this.cache = new WorldCache();
    this.unsubs = [
      transport.on('session.ready', () => transport.send({type:'world.subscribe',payload:{}})),
      this.cache.on('stats', stats => events.emit('cache.stats', stats)),
      this.cache.on('evict', key => {
        if (key.startsWith('chunk:')) {
          const id = key.slice(6); scene.unload(id);
          if (transport.ready) transport.command('chunk.release',{ chunk_id: id });
        }
      }),
      transport.on('world.offer', offer => this.stateOffer(offer)),
      transport.on('world.snapshot', snapshot => this.snapshot(snapshot)),
      transport.on('world.delta', delta => this.delta(delta)),
      transport.on('chunk.offer', offer => this.offer(offer)),
      transport.on('chunk.load', chunk => this.load(chunk)),
      transport.on('chunk.unload', ({chunk_id}) => this.cache.drop('chunk:'+chunk_id)),
      transport.on('status', status => {
        scene.enabled = status === 'connected' && !!this.state; scene.controls.clear();
        if (['connecting', 'reconnecting', 'unauthorized'].includes(status)) { this.cache.reset(); this.state = null; scene.reset(); } events.emit('connection.status',status);
      }),
      transport.on('error', error => events.emit('notice',error)),
      transport.on('message', message => events.emit(message.type,message.payload)),
      events.on('player.input', input => { if (this.state?.stage !== 'lobby') transport.input(input); }),
      events.on('command', ({type,payload}) => this.command(type,payload)),
      events.on('build.request', () => {
        if (scene.selected && (this.buildType || 'drill') === 'drill' && !['water','iron','sulfur'].includes(scene.selected.resource)) {
          events.emit('notice','Бур можно построить только на ресурсной клетке: В, Ж или С.'); return;
        }
        if (scene.selected) this.command('building.place',{cell_id:scene.selected.cell_id,building_type:this.buildType || 'drill'});
      }),
      events.on('build.type', type => { this.buildType = type; scene.buildType = type; scene.select(scene.selected); }),
      events.on('interact.request', () => events.emit('building.selected',scene.nearestBuilding())),
    ];
  }
  fail(message) {
    this.scene.enabled = false; this.events.emit('notice',message);
    this.transport.resync();
  }
  stateOffer({total_bytes, byte_size}) {
    if (!this.cache.total) {
      if (!Number.isSafeInteger(total_bytes) || total_bytes <= 0) return this.fail('Некорректный размер мира.');
      this.cache.reset(total_bytes);
    }
    if (!this.cache.reserve('incoming:state',byte_size,{pinned:true})) return this.fail('Нет места для входящего состояния.');
    this.transport.send({type:'world.accept',payload:{}});
  }
  acceptState(data) {
    if (!this.cache.commit('incoming:state',data)) {
      this.fail('Состояние пришло без резерва или размер не совпадает.'); return false;
    }
    return true;
  }
  snapshot(snapshot) {
    if (!this.acceptState(snapshot)) return;
    const w = snapshot.world;
    if (!w || !Number.isFinite(w.radius) || w.radius <= 0 || !Number.isSafeInteger(w.total_bytes) || w.total_bytes <= 0
      || !Number.isFinite(w.move_speed) || w.move_speed <= 0 || !Number.isFinite(w.view_radius) || w.view_radius <= 0
      || !Number.isFinite(w.build_distance) || !w.shell || w.shell.radius <= 0
      || !Number.isInteger(w.shell.detail) || w.shell.detail < 0 || w.shell.detail > 3
      || !snapshot.players?.some(p => p.player_id === snapshot.self_id)) {
      throw new Error('Snapshot не соответствует клиентскому контракту; см. docs/client-integration.md');
    }
    if (w.total_bytes !== this.cache.total) return this.fail('Размер мира отличается от манифеста.');
    this.cache.drop('incoming:state');
    for (const key of [...this.cache.entries.keys()]) this.cache.drop(key);
    this.scene.reset();
    // Shell is retained only in this one canonical snapshot DTO; not counted twice.
    if (!this.cache.put('state',snapshot,{pinned:true})) return this.fail('Snapshot превышает бюджет данных.');
    this.state = snapshot;
    this.events.emit('world.stage', snapshot.stage);
    this.events.emit('world.snapshot', snapshot);
    this.scene.configure(snapshot);
    this.events.emit('world.ready',{selfId:snapshot.self_id,teamId:snapshot.team_id,totalChunks:w.total_chunks});
  }
  delta(delta) {
    if (!this.state || !this.acceptState(delta)) return;
    const merge = (old, updates=[], removed=[], id) => {
      const values = new Map(old.map(v=>[v[id],v]));
      removed.forEach(key=>values.delete(key)); updates.forEach(v=>values.set(v[id],v)); return [...values.values()];
    };
    const next = { ...this.state, ...delta,
      players:merge(this.state.players,delta.players,delta.removed_players,'player_id'),
      buildings:merge(this.state.buildings || [],delta.buildings,delta.removed_buildings,'building_id') };
    this.cache.drop('incoming:state');
    if (!this.cache.put('state',next,{pinned:true})) return this.fail('Динамическое состояние превышает бюджет данных.');
    this.state=next; this.scene.applyState(delta);
    this.events.emit('world.stage', next.stage);
  }
  offer({chunk_id,byte_size,distance=0}) {
    if (typeof chunk_id !== 'string') return this.fail('Некорректный chunk.offer');
    const key='chunk:'+chunk_id;
    if (this.cache.entries.has(key)) return;
    if (this.cache.reserve(key,byte_size,{distance})) this.command('chunk.request',{chunk_id});
    else this.command('chunk.release',{chunk_id});
  }
  load(chunk) {
    const key='chunk:'+chunk.chunk_id;
    if (!Array.isArray(chunk.cells) || !this.cache.commit(key,chunk)) {
      this.cache.drop(key); this.command('chunk.release',{chunk_id:chunk.chunk_id});
      this.events.emit('notice','Чанк отклонён: отсутствует резерв или размер не совпадает.'); return;
    }
    this.scene.load(chunk);
    const ids=new Set(chunk.cells.map(cell=>cell.cell_id));
    this.scene.applyState({buildings:(this.state?.buildings || []).filter(building=>ids.has(building.cell_id))});
  }
  command(type,payload) {
    const allowed = new Set(['landing.select','world.start','player.color','building.place','resource.pickup','resource.deposit','resource.give','chat.send','agent.ask','chunk.request','chunk.release']);
    if (!allowed.has(type)) { this.events.emit('notice','Неизвестная клиентская команда'); return; }
    try { return this.transport.command(type,payload); }
    catch (error) { this.events.emit('notice',error.message); }
  }
  dispose() { this.unsubs.forEach(fn=>fn()); this.transport.close(); this.scene.dispose(); this.cache.reset(); }
}

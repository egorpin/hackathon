export class Controls {
  constructor(canvas, events) {
    this.canvas = canvas; this.events = events; this.keys = new Set(); this.yaw = 0; this.pitch = 0;
    this.controller = new AbortController();
    const on = (target, name, fn) => target.addEventListener(name, fn, { signal: this.controller.signal });
    const editing = target => target?.closest?.('input,textarea,select,[contenteditable=true]');
    on(window, 'keydown', e => {
      if (this.suspended || editing(e.target)) return;
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (!e.repeat && e.code === 'Tab') events.emit('camera.toggle');
      if (!e.repeat && e.code === 'KeyB') events.emit('build.request');
      if (!e.repeat && e.code === 'KeyE') events.emit('interact.request');
    });
    on(window, 'keyup', e => this.keys.delete(e.code));
    on(window, 'blur', () => this.clear());
    on(document, 'visibilitychange', () => { if (document.hidden) this.clear(); });
    on(document, 'focusin', e => { if (editing(e.target)) this.clear(); });
    on(document, 'pointerlockchange', () => { this.clear(); });
    on(document, 'mousemove', e => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * .002;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * .002));
    });
    on(canvas, 'click', async e => {
      if(this.suspended)return;
      events.emit('scene.click', e);
      if (this.mode !== 'first') return;
      try { await canvas.requestPointerLock(); }
      catch { events.emit('notice', 'Захват мыши недоступен. Используйте стрелки для поворота.'); }
    });
  }
  clear() { this.keys.clear(); this.yaw = 0; }
  axes(dt = 0) {
    if(this.suspended)return {forward:0,right:0};
    this.yaw += ((this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0)) * dt * 1.5;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + ((this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0)) * dt));
    return { forward: +this.keys.has('KeyW') - +this.keys.has('KeyS'), right: +this.keys.has('KeyD') - +this.keys.has('KeyA') };
  }
  dispose() { this.controller.abort(); if (document.pointerLockElement === this.canvas) document.exitPointerLock(); }
}

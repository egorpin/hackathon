import { buildingForKey } from '../ui/buildings.js';

export class Controls {
  constructor(canvas, events) {
    this.canvas = canvas; this.events = events; this.keys = new Set(); this.yaw = 0; this.pitch = 0;
    this.controller = new AbortController();
    const on = (target, name, fn, options = {}) => target.addEventListener(name, fn, { ...options, signal: this.controller.signal });
    const editing = target => target?.closest?.('input,textarea,select,[contenteditable=true]');
    on(window, 'keydown', e => {
      if (this.suspended || editing(e.target) || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const building = buildingForKey(e.code);
      if (building) { e.preventDefault(); if (!e.repeat) events.emit('build.choose', building); return; }
      if (!e.repeat && e.code === 'Escape') events.emit('build.cancel');
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab','Space'].includes(e.code)) e.preventDefault();
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
      if (this.mode === 'top' && this.drag && !this.suspended) {
        const dx=e.clientX-this.drag.x, dy=e.clientY-this.drag.y;
        this.drag.x=e.clientX; this.drag.y=e.clientY; this.drag.distance+=Math.abs(dx)+Math.abs(dy);
        events.emit('camera.orbit',{x:dx*.008,y:dy*.008}); return;
      }
      if (document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * .002;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * .002));
    });
    on(canvas, 'mousedown', e => { if(this.mode==='top' && !this.suspended && e.button===0)this.drag={x:e.clientX,y:e.clientY,distance:0}; });
    on(canvas, 'pointermove', e => { if(this.mode==='top' && !this.suspended && !this.drag)events.emit('scene.pointer',e); });
    on(document, 'mouseup', () => { this.dragged=(this.drag?.distance || 0)>4;this.drag=null; });
    on(canvas, 'wheel', e => {
      if(this.mode!=='top' || this.suspended)return;
      e.preventDefault();
      events.emit('camera.zoom',Math.max(-1,Math.min(1,e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?600:1)/400)));
    }, {passive:false});
    on(canvas, 'click', async e => {
      if(this.suspended)return;
      if(this.dragged){this.dragged=false;return;}
      events.emit('scene.click', e);
      if (this.mode !== 'first') return;
      try { await canvas.requestPointerLock(); }
      catch { events.emit('notice', 'Захват мыши недоступен. Используйте стрелки для поворота.'); }
    });
  }
  clear() { this.keys.clear(); this.yaw = 0; this.drag=null;this.dragged=false; }
  axes(dt = 0) {
    if(this.suspended)return {forward:0,right:0};
    if(this.mode==='top') {
      const x=(+this.keys.has('ArrowRight')-+this.keys.has('ArrowLeft'))*dt*3;
      const y=(+this.keys.has('ArrowDown')-+this.keys.has('ArrowUp'))*dt*3;
      if(x||y)this.events.emit('camera.orbit',{x,y});
      return {forward:+this.keys.has('KeyW')-+this.keys.has('KeyS'),right:+this.keys.has('KeyD')-+this.keys.has('KeyA')};
    }
    this.yaw += ((this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0)) * dt * 1.5;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + ((this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0)) * dt));
    return { forward: +this.keys.has('KeyW') - +this.keys.has('KeyS'), right: +this.keys.has('KeyD') - +this.keys.has('KeyA') };
  }
  dispose() { this.controller.abort(); if (document.pointerLockElement === this.canvas) document.exitPointerLock(); }
}

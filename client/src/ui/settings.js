import './settings.css';

const read = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, String(value)); return true; }
  catch { return false; }
};

export class Settings {
  constructor({events, scene}) {
    Object.assign(this, {events, scene, connected:false, state:null});
    this.abort = new AbortController();
    this.button = document.createElement('button');
    this.button.id = 'settings-toggle';
    this.button.type = 'button';
    this.button.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.5 2-2 .9-1.9-.6-2.5 4.3L4 11v2l-1.4 1.4 2.5 4.3 1.9-.6 2 .9.5 2h5l.5-2 2-.9 1.9.6 2.5-4.3L20 13v-2l1.4-1.4-2.5-4.3-1.9.6-2-.9-.5-2z"/><circle cx="12" cy="12" r="3.2"/></svg>';
    this.button.setAttribute('aria-label', 'Настройки');
    this.button.title = 'Настройки';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-controls', 'game-settings');
    this.button.setAttribute('aria-expanded', 'false');
    document.querySelector('.header-actions').append(this.button);
    const panel = this.panel = document.createElement('dialog');
    panel.id = 'game-settings';
    panel.className = 'game-settings';
    panel.setAttribute('aria-labelledby', 'settings-title');
    panel.innerHTML = `
      <div class="settings-heading"><div><span class="eyebrow">ИГРА</span><h2 id="settings-title">Настройки</h2></div><button type="button" class="settings-close" aria-label="Закрыть настройки игры">✕</button></div>
      <fieldset><legend>Экспедиция</legend>
        <div class="settings-respawn"><span>Вернуться к последней базе, базе команды или посадочной площадке.</span><button type="button" id="player-respawn" disabled>К базе</button></div>
      </fieldset>
      <fieldset><legend>Графика</legend>
        <label class="settings-quality" for="quality">Качество<select id="quality"><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label>
        <label class="settings-fov" for="camera-fov"><span>Угол обзора<small>Камера от первого лица · <output id="camera-fov-value" for="camera-fov">70°</output></small></span><input id="camera-fov" type="range" min="50" max="110" step="1"></label>
        <label class="settings-switch"><span>Звёзды</span><input id="stars" type="checkbox" role="switch"></label>
        <label class="settings-switch"><span>Камни<small>Декор поверхности. Ресурсы остаются видимыми.</small></span><input id="rocks" type="checkbox" role="switch"></label>
        <label class="settings-switch"><span>Пыль в воздухе</span><input id="dust" type="checkbox" role="switch"></label>
      </fieldset>
      <fieldset><legend>Движение и эффекты</legend>
        <label class="settings-switch"><span>Анимации<small>Персонажи, механизмы, пыль и переходы меню.</small></span><input id="animations" type="checkbox" role="switch"></label>
        <label class="settings-switch"><span>Покачивание при ходьбе</span><input id="camera-bob" type="checkbox" role="switch"></label>
      </fieldset>
      <fieldset><legend>Информация на экране</legend>
        <label class="settings-switch"><span>Счётчик FPS</span><input id="show-fps" type="checkbox" role="switch"></label>
        <label class="settings-switch"><span>Технические данные<small>Время кадра, отрисовка и загрузка мира.</small></span><input id="show-diagnostics" type="checkbox" role="switch"></label>
      </fieldset>
      <p class="settings-note" role="status">Изменения применяются сразу и сохраняются на этом устройстве.</p>
      <button type="button" class="settings-done">Готово</button>`;
    document.body.append(panel);
    const on = (node, event, handler) => node.addEventListener(event, handler, {signal:this.abort.signal});
    on(this.button, 'click', () => this.open());
    on(panel.querySelector('.settings-close'), 'click', () => panel.close());
    on(panel.querySelector('.settings-done'), 'click', () => panel.close());
    on(panel.querySelector('#player-respawn'), 'click', () => {
      if (!this.connected || this.state?.stage !== 'running') return;
      scene.controls.clear();
      events.emit('command', {type:'player.respawn', payload:{}});
      panel.close();
    });
    const updateRespawn = () => { panel.querySelector('#player-respawn').disabled = !this.connected || this.state?.stage !== 'running'; };
    this.unsubs = [
      events.on('world.state', state => { this.state = state; updateRespawn(); }),
      events.on('connection.status', status => { this.connected = status === 'connected'; if (!this.connected) this.state = null; updateRespawn(); }),
    ];
    on(panel, 'close', () => this.resume());
    // Keep gameplay shortcuts (including the flashlight) out of a modal dialog.
    on(panel, 'keydown', event => event.stopPropagation());
    const quality = panel.querySelector('#quality');
    const storedQuality = read('mars.graphics.quality', 'medium');
    quality.value = ['low', 'medium', 'high'].includes(storedQuality) ? storedQuality : 'medium';
    on(quality, 'change', () => {
      this.save('mars.graphics.quality', quality.value);
      events.emit('graphics.quality', quality.value);
    });
    events.emit('graphics.quality', quality.value);
    const fovInput=panel.querySelector('#camera-fov'),fovValue=panel.querySelector('#camera-fov-value');
    const storedFov=Number(read('mars.graphics.fov','70'));
    fovInput.value=String(Number.isInteger(storedFov)&&storedFov>=50&&storedFov<=110?storedFov:70);
    fovValue.value=fovValue.textContent=`${fovInput.value}°`;
    const applyFov=()=>{const value=Number(fovInput.value);fovValue.value=`${value}°`;fovValue.textContent=`${value}°`;this.save('mars.graphics.fov',value);events.emit('graphics.fov',value);};
    on(fovInput,'input',applyFov);
    events.emit('graphics.fov',Number(fovInput.value));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [id, key, fallback, apply] of [
      ['stars', 'mars.graphics.stars', true, value => events.emit('graphics.effects', {stars:value})],
      ['rocks', 'mars.graphics.rocks', true, value => events.emit('graphics.effects', {rocks:value})],
      ['dust', 'mars.graphics.dust', true, value => events.emit('graphics.effects', {dust:value})],
      ['animations', 'mars.graphics.animations', !reduced, value => {
        events.emit('graphics.effects', {animations:value});
        document.documentElement.classList.toggle('game-reduced-motion', !value);
        panel.querySelector('#camera-bob').disabled = !value;
      }],
      ['camera-bob', 'mars.graphics.bob', true, value => events.emit('graphics.bob', value)],
      ['show-fps', 'mars.hud.fps', false, () => this.updateTelemetry()],
      ['show-diagnostics', 'mars.hud.diagnostics', false, () => this.updateTelemetry()],
    ]) {
      const input = panel.querySelector('#' + id);
      input.checked = read(key, String(fallback)) === 'true';
      on(input, 'change', () => { this.save(key, input.checked); apply(input.checked); });
      apply(input.checked);
    }
  }

  save(key, value) {
    const saved = write(key, value);
    this.panel.querySelector('.settings-note').textContent = saved
      ? 'Изменения применяются сразу и сохраняются на этом устройстве.'
      : 'Изменения применены. Браузер не разрешает сохранить их после закрытия.';
  }

  updateTelemetry() {
    const fps = this.panel.querySelector('#show-fps').checked;
    const diagnostics = this.panel.querySelector('#show-diagnostics').checked;
    for (const [id, visible] of [['telemetry', fps || diagnostics], ['performance', fps], ['performance-detail', diagnostics], ['cache', diagnostics]]) {
      const node = document.getElementById(id);
      if (node) node.hidden = !visible;
    }
  }

  open() {
    if (this.panel.open) return;
    this.scene.controls.suspended = true;
    this.scene.controls.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.events.emit('ui.overlay', true);
    this.panel.showModal();
    this.button.setAttribute('aria-expanded', 'true');
    this.panel.querySelector('.settings-close').focus();
  }

  resume() {
    const suspended = !!document.querySelector('dialog[open]');
    this.scene.controls.suspended = suspended;
    this.scene.controls.clear();
    this.events.emit('ui.overlay', suspended);
    this.button.setAttribute('aria-expanded', 'false');
    if (!suspended) this.button.focus({preventScroll:true});
  }

  dispose() {
    if (this.panel.open) this.panel.close();
    this.unsubs.forEach(unsubscribe => unsubscribe());
    this.abort.abort();
    this.panel.remove();
    this.button.remove();
  }
}

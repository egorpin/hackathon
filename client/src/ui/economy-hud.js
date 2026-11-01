import './economy-hud.css';
import { BUILDINGS } from './buildings.js';
import { transferPlan } from './economy.js';
import { surfaceDistance, vector } from '../scene/motion.js';

const resources = {iron:'Железо', copper:'Медь', water:'Вода', sulfur:'Сера'};
const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', {maximumFractionDigits:1}) : '—';
const total = stock => Object.values(stock || {}).reduce((sum, amount) => sum + (Number.isFinite(amount) ? amount : 0), 0);

export class EconomyHUD {
  constructor({events, scene}) {
    Object.assign(this, {events, scene, connected:false, state:null, selectedId:null});
    this.abort = new AbortController();
    this.strip = document.createElement('section');
    this.strip.className = 'economy-hud';
    this.strip.hidden = true;
    this.strip.setAttribute('aria-label', 'Общие ресурсы команды и кислород планеты');
    this.strip.innerHTML = `
      <div class="economy-resources">${Object.entries(resources).map(([key, label]) => `<span title="${label}: общий запас команды">${label} <strong data-resource="${key}">—</strong></span>`).join('')}</div>
      <div class="economy-summary"><span id="planet-oxygen">O₂ —</span></div>
      <div class="economy-inventory" aria-label="Личный инвентарь"><span id="inventory-capacity">Рюкзак —</span><span id="inventory-resources">пусто</span></div>
      <progress id="oxygen-progress" max="100" value="0" aria-label="Кислород планеты"></progress>`;
    document.querySelector('header').insertBefore(this.strip, document.querySelector('.header-actions'));
    this.panel = document.createElement('dialog');
    this.panel.className = 'building-panel';
    this.panel.setAttribute('aria-labelledby', 'building-panel-title');
    this.panel.innerHTML = `
      <div class="building-panel-heading"><div><span class="eyebrow">ПОСТРОЙКА</span><h2 id="building-panel-title"></h2></div><button type="button" class="building-panel-close" aria-label="Закрыть постройку">✕</button></div>
      <p id="building-operation"></p><p id="building-stock"></p>
      <p id="building-access" role="status"></p>
      <div class="building-transfers"><button type="button" id="building-pickup" hidden>Забрать ресурсы · E</button><button type="button" id="building-deposit" hidden>Сдать ресурсы на склад · E</button><p id="building-transfer-hint"></p></div>
      <p class="building-refund">При сносе в общий запас вернутся 100% оплаченной стоимости и остатки ресурсов постройки.</p>
      <div class="building-panel-actions"><button type="button" id="building-remove">Снести постройку</button><button type="button" class="building-panel-done">Закрыть</button></div>`;
    document.body.append(this.panel);
    const on = (element, event, callback) => element.addEventListener(event, callback, {signal:this.abort.signal});
    for (const button of this.panel.querySelectorAll('.building-panel-close,.building-panel-done')) on(button, 'click', () => this.panel.close());
    on(this.panel, 'keydown', event => {
      event.stopPropagation();
      if (event.code !== 'KeyE' || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      const type = this.selected()?.building_type;
      if (!['drill', 'warehouse', 'oxygen_generator'].includes(type)) return;
      event.preventDefault();
      this.transfer(type === 'drill' ? 'resource.pickup' : 'resource.deposit');
    });
    on(this.panel, 'close', () => this.resume());
    on(this.panel.querySelector('#building-pickup'), 'click', () => this.transfer('resource.pickup'));
    on(this.panel.querySelector('#building-deposit'), 'click', () => this.transfer('resource.deposit'));
    on(this.panel.querySelector('#building-remove'), 'click', () => {
      const building = this.selected();
      if (!building || this.accessReason(building)) return;
      events.emit('command', {type:'building.remove', payload:{building_id:building.building_id}});
      this.panel.close();
    });
    this.unsubs = [
      events.on('world.state', state => { this.state = state; this.render(); }),
      events.on('building.selected', building => this.open(building)),
      events.on('expedition.lobby', () => { this.selectedId = null; if (this.panel.open) this.panel.close(); }),
      events.on('connection.status', status => {
        this.connected = status === 'connected';
        if (!this.connected) {
          // A new session becomes connected before its snapshot arrives. Do not
          // enable actions against the previous session's buildings or position.
          this.state = null;
          if (this.panel.open) this.panel.close();
        }
        this.render();
      }),
    ];
  }

  playable() { return this.connected && this.state?.stage === 'running'; }
  selected() { return this.state?.buildings?.find(building => building.building_id === this.selectedId); }

  accessReason(building) {
    if (!this.playable()) return 'Дождитесь начала экспедиции и подключения к серверу.';
    if (building.team_id !== this.state.team_id) return 'Постройка другой команды: взаимодействие недоступно.';
    const player = this.state.players?.find(item => item.player_id === this.state.self_id);
    const radius = this.state.world?.radius ?? this.state.config?.radius;
    const reach = this.state.config?.interaction_distance;
    if (!player?.position || !building.position || !Number.isFinite(radius) || !Number.isFinite(reach)) return 'Ожидание положения игрока и постройки.';
    if (surfaceDistance(vector(player.position), vector(building.position), radius) > reach) return 'Подойдите ближе к постройке для взаимодействия.';
    return '';
  }

  transferPlan(building, command) {
    const pickup = command === 'resource.pickup';
    if (!building || !(pickup ? ['drill'] : ['warehouse', 'oxygen_generator']).includes(building.building_type) || this.accessReason(building)) return [];
    const state = this.state;
    const generator = !pickup && building.building_type === 'oxygen_generator';
    const source = pickup ? building.stock : generator ? {water:state.inventory?.water || 0} : state.inventory;
    const destination = pickup ? state.inventory : generator ? building.stock : state.team_storage;
    const capacity = pickup ? state.config?.inventory_capacity : generator ? state.config?.building_capacity : state.config?.storage_capacity;
    return transferPlan(source, destination, capacity)
      .map(item => ({building_id:building.building_id, ...item}));
  }

  transfer(command) {
    const plan = this.transferPlan(this.selected(), command);
    if (!plan.length) return;
    // Each message uses the existing server command contract; the room budget
    // is shared across all resources in this pickup/deposit action.
    for (const payload of plan) this.events.emit('command', {type:command, payload});
    this.panel.close();
  }

  render() {
    const state = this.state;
    this.strip.hidden = !state?.team_storage || state.stage !== 'running';
    this.strip.classList.toggle('is-offline', !this.connected);
    if (state?.team_storage) {
      for (const [key, label] of Object.entries(resources)) {
        const item = this.strip.querySelector(`[data-resource="${key}"]`);
        item.textContent = number(state.team_storage[key] ?? 0);
        item.parentElement.setAttribute('aria-label', `${label}: ${item.textContent}`);
      }
      const inventoryUsed = total(state.inventory), inventoryCapacity = state.config?.inventory_capacity;
      const inventoryNode = this.strip.querySelector('#inventory-capacity');
      inventoryNode.textContent = `Рюкзак ${number(inventoryUsed)} / ${number(inventoryCapacity)}`;
      inventoryNode.classList.toggle('is-full', Number.isFinite(inventoryCapacity) && inventoryUsed >= inventoryCapacity);
      const carried = Object.entries(state.inventory || {}).filter(([, amount]) => amount > 0);
      const inventoryResources = this.strip.querySelector('#inventory-resources');
      const symbols = {iron:'Fe', copper:'Cu', water:'H₂O', sulfur:'S', ore:'руды'};
      inventoryResources.textContent = carried.map(([resource, amount]) => `${number(amount)} ${symbols[resource] || resource}`).join(' · ') || 'пусто';
      inventoryResources.title = carried.map(([resource, amount]) => `${resources[resource] || resource}: ${number(amount)}`).join(', ') || 'В рюкзаке нет ресурсов';
      const oxygen = state.oxygen_percent ?? state.oxygen ?? 0;
      const goal = state.oxygen_goal > 0 ? state.oxygen_goal : 100;
      this.strip.querySelector('#planet-oxygen').textContent = `O₂ ${number(oxygen)}%`;
      const progress = this.strip.querySelector('#oxygen-progress');
      progress.max = goal;
      progress.value = oxygen;
      progress.setAttribute('aria-valuetext', `${number(oxygen)}% из ${number(goal)}%`);
    }
    if (!this.panel.open) return;
    const building = this.selected();
    if (!building) { this.panel.close(); return; }
    this.renderBuilding(building);
  }

  renderBuilding(building) {
    const state = this.state, config = state.config || {}, pool = state.team_storage || {};
    const type = building.building_type;
    this.panel.querySelector('#building-panel-title').textContent = BUILDINGS.find(item => item.type === type)?.name || 'Постройка';
    const cycle = config.production_ticks * config.tick_seconds;
    const period = Number.isFinite(cycle) ? `за ${number(cycle)} с` : 'за цикл';
    let operation = '';
    if (type === 'drill') operation = total(building.stock) >= config.building_capacity
      ? 'Бур заполнен, добыча приостановлена. Заберите ресурсы в рюкзак и отнесите их на склад.'
      : `Добывает 1 ресурс месторождения ${period} и хранит его внутри (до ${number(config.building_capacity)}). Заберите ресурсы в рюкзак и отнесите их на склад.`;
    if (type === 'oxygen_generator') {
      operation = (state.oxygen_percent ?? state.oxygen) >= (state.oxygen_goal || 100)
        ? 'Цель по кислороду достигнута. Генератор больше не расходует воду.'
        : `Для работы: 1 вода из внутреннего запаса ${period}, +${number(config.oxygen_per_cycle)} процентного пункта O₂. Разгрузите воду из рюкзака прямо в генератор или сдайте её на склад вашей команды на соседней клетке — он автоматически подаёт нужную воду из общего запаса.`;
    }
    if (type === 'warehouse') operation = `Добавляет ${number(config.warehouse_capacity)} единиц к общей вместимости команды. Сдавайте сюда ресурсы из рюкзака для строительства. Склад автоматически передаёт только нужные ресурсы постройкам вашей команды на соседних клетках: генератору — воду. Дальние постройки он не снабжает.`;
    if (type === 'dome_base') operation = 'Точка возрождения. Кнопка «К базе» возвращает к последней вашей базе; если её нет — к базе команды или посадочной площадке.';
    if (building.team_id !== state.team_id) operation = 'Постройка другой команды.';
    this.panel.querySelector('#building-operation').textContent = operation;
    const stock = this.panel.querySelector('#building-stock');
    stock.hidden = !building.stock;
    stock.textContent = building.stock ? `${type === 'warehouse' ? 'Общий запас' : 'Внутри постройки'}: ${Object.entries(building.stock).filter(([, amount]) => amount > 0).map(([key, amount]) => `${resources[key] || key} ${number(amount)}`).join(' · ') || 'пусто'}.` : '';
    const reason = this.accessReason(building);
    this.panel.querySelector('#building-access').textContent = reason;
    this.panel.querySelector('#building-remove').disabled = !!reason;
    this.panel.querySelector('.building-refund').hidden = building.team_id !== state.team_id;
    const pickup = this.panel.querySelector('#building-pickup'), deposit = this.panel.querySelector('#building-deposit');
    pickup.hidden = type !== 'drill';
    deposit.hidden = !['warehouse', 'oxygen_generator'].includes(type);
    deposit.textContent = type === 'oxygen_generator' ? 'Разгрузить воду · E' : 'Сдать ресурсы на склад · E';
    const plan = this.transferPlan(building, type === 'drill' ? 'resource.pickup' : 'resource.deposit');
    pickup.disabled = deposit.disabled = !plan.length;
    let transferHint = '';
    if (!reason && type === 'drill') transferHint = plan.length
      ? `В рюкзак: ${number(plan.reduce((sum, payload) => sum + payload.amount, 0))} ед.`
      : total(state.inventory) >= config.inventory_capacity ? 'Рюкзак заполнен. Сдайте ресурсы на склад.' : 'В буре пока нет ресурсов.';
    if (!reason && type === 'warehouse') transferHint = plan.length
      ? `В общий запас: ${number(plan.reduce((sum, payload) => sum + payload.amount, 0))} ед.`
      : total(pool) >= config.storage_capacity ? 'Общий запас заполнен.' : 'В рюкзаке нет ресурсов для сдачи.';
    if (!reason && type === 'oxygen_generator') transferHint = plan.length
      ? `В генератор: ${number(plan.reduce((sum, payload) => sum + payload.amount, 0))} воды. Остальные ресурсы останутся в рюкзаке.`
      : total(building.stock) >= config.building_capacity ? 'Внутренний запас генератора заполнен.' : 'В рюкзаке нет воды. Генератор принимает только воду.';
    this.panel.querySelector('#building-transfer-hint').textContent = transferHint;
  }

  open(building) {
    if (!building) { this.events.emit('notice', 'Рядом нет построек. Подойдите к постройке и нажмите E.'); return; }
    this.selectedId = building.building_id;
    const current = this.selected();
    if (!current || !this.playable()) return;
    this.renderBuilding(current);
    if (this.panel.open) return;
    this.scene.controls.suspended = true;
    this.scene.controls.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.events.emit('ui.overlay', true);
    this.panel.showModal();
    this.panel.querySelector('.building-panel-close').focus();
  }

  resume() {
    // close events are queued: a newly opened dialog may already have replaced
    // the one that caused this event. Keep its selection and input suspension.
    if (this.panel.open) return;
    this.selectedId = null;
    const suspended = !!document.querySelector('dialog[open]');
    this.scene.controls.suspended = suspended;
    this.scene.controls.clear();
    this.events.emit('ui.overlay', suspended);
  }

  dispose() {
    if (this.panel.open) { this.panel.close(); this.resume(); }
    this.unsubs.forEach(unsubscribe => unsubscribe());
    this.abort.abort();
    this.strip.remove();
    this.panel.remove();
  }
}

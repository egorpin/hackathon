import { buildingTransfer } from './economy.js';
import { surfaceDistance, vector } from '../scene/motion.js';

export class AimResources {
  constructor({events}) {
    this.events = events;
    this.button = document.createElement('button');
    this.button.id = 'resource-transfer';
    this.button.type = 'button';
    this.button.hidden = true;
    document.querySelector('main').append(this.button);
    this.button.onclick = () => this.pickup();
    this.unsubs = [
      events.on('world.state',state=>{this.state=state;this.render();}),
      events.on('building.targeted',building=>{this.targetId=building?.building_id;this.render();}),
      events.on('pickup.request',()=>this.pickup()),
      events.on('connection.status',status=>{this.connected=status==='connected';if(!this.connected)this.state=null;this.render();}),
      events.on('ui.overlay',open=>{this.overlay=open;this.render();}),
    ];
  }
  target() { return this.state?.buildings?.find(b=>b.building_id===this.targetId && ['drill','warehouse','oxygen_generator'].includes(b.building_type)); }
  available(building) {
    const state=this.state;
    if (!building || !this.connected || this.overlay || state.stage!=='running' || building.team_id!==state.team_id) return false;
    const player=state.players?.find(p=>p.player_id===state.self_id);
    return !!player?.position && !!building.position && Number.isFinite(state.config?.interaction_distance)
      && surfaceDistance(vector(player.position),vector(building.position),state.world.radius)<=state.config.interaction_distance;
  }
  plan(building) { return buildingTransfer(this.state,building); }
  render() {
    const building=this.target();
    this.button.hidden=!this.available(building);
    if(this.button.hidden)return;
    const count=this.plan(building).items.reduce((sum,item)=>sum+item.amount,0);
    this.button.disabled=!count;
    const type=building.building_type;
    const label=type==='drill'?'Забрать ресурсы':type==='warehouse'?'Разгрузить ресурсы':'Разгрузить воду';
    const hasSource=type==='drill'?Object.values(building.stock || {}).some(amount=>amount>0):
      type==='oxygen_generator'?this.state.inventory?.water>0:Object.values(this.state.inventory || {}).some(amount=>amount>0);
    const empty=type==='drill'?'Бур накапливает ресурсы…':type==='oxygen_generator'?'В рюкзаке нет воды':'Рюкзак пуст';
    const full=type==='drill'?'Рюкзак заполнен':type==='warehouse'?'Склад заполнен':'Генератор заполнен';
    this.button.textContent=count ? `${label} (${count}) · ЛКМ` : hasSource?full:empty;
  }
  pickup() {
    const building=this.target();
    if (!this.available(building))return;
    const {type,items}=this.plan(building);
    for(const item of items)this.events.emit('command',{type,payload:{building_id:building.building_id,...item}});
  }
  dispose() { this.unsubs.forEach(fn=>fn());this.button.remove(); }
}

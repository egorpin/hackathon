import { buildingTransfer } from './economy.js';
import { aimedBuilding } from './interaction.js';

export class AimResources {
  constructor({events,scene}) {
    this.scene = scene;
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
  target(refresh=false) { const b=aimedBuilding(this.scene,this.state,refresh); return b && ['drill','warehouse','oxygen_generator'].includes(b.building_type) ? b : null; }
  available(building) {
    const state=this.state;
    if (!building || !this.connected || this.overlay || state.stage!=='running' || building.team_id!==state.team_id) return false;
    return true;
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
    const building=this.target(true);
    if (!this.available(building))return;
    const {type,items}=this.plan(building);
    for(const item of items)this.events.emit('command',{type,payload:{building_id:building.building_id,...item}});
  }
  dispose() { this.unsubs.forEach(fn=>fn());this.button.remove(); }
}

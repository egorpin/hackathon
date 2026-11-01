import { inInteractionRange } from './interaction.js';
import { restorePointerLock } from './pointer-lock.js';

export function nearbyRecipients(state) {
  if (state?.stage !== 'running') return [];
  return (state.players || []).filter(player => player.player_id !== state.self_id
    && player.team_id === state.team_id
    && inInteractionRange(state, {...player, interaction_distance: state.config?.interaction_distance}));
}

export function givePayload(state, recipient, resource, amount) {
  if (!nearbyRecipients(state).some(player => player.player_id === recipient)
      || !['iron','copper','water','sulfur','ore'].includes(resource)
      || !Number.isInteger(amount) || amount < 1 || amount > state.config?.inventory_capacity
      || amount > (state.inventory?.[resource] || 0)) return null;
  return {recipient_player_id:recipient, resource, amount};
}

export class PlayerTransfer {
  constructor({events, scene}) {
    this.events=events; this.scene=scene; this.abort=new AbortController();
    this.button=document.createElement('button');
    this.button.id='player-transfer-open'; this.button.hidden=true;
    this.button.textContent='Передать вещи · G';
    this.panel=document.createElement('dialog');
    this.panel.className='building-panel player-transfer-panel';
    this.panel.setAttribute('aria-label','Передача вещей');
    this.panel.innerHTML=`<h2>Передать вещи</h2><form>
      <label>Игрок рядом<select name="recipient" required></select></label>
      <label>Ресурс<select name="resource"><option value="iron">Железо</option><option value="copper">Медь</option><option value="water">Лёд</option><option value="sulfur">Сера</option><option value="ore">Руда</option></select></label>
      <label>Количество<input name="amount" type="number" min="1" step="1" value="1" required></label>
      <p class="transfer-status" role="status"></p><div class="building-panel-actions"><button type="button" class="transfer-close">Закрыть · Esc</button><button type="submit">Передать</button></div></form>`;
    document.querySelector('main').append(this.button,this.panel);
    this.form=this.panel.querySelector('form'); this.fields=this.form.elements;
    this.status=this.panel.querySelector('.transfer-status');
    const on=(node,type,fn)=>node.addEventListener(type,fn,{signal:this.abort.signal});
    on(this.button,'click',()=>this.open());
    on(this.panel.querySelector('.transfer-close'),'click',()=>{this.panel.close();this.resume();});
    on(this.panel,'close',()=>this.resume());
    on(this.form,'input',()=>this.render());
    on(this.form,'submit',event=>{event.preventDefault();this.send();});
    on(window,'keydown',event=>{
      if(event.code!=='KeyG' || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
        || event.target?.closest?.('input,textarea,select,[contenteditable]'))return;
      if(!this.button.hidden){event.preventDefault();this.open();}
    });
    this.unsubs=[
      events.on('world.state',state=>{this.state=state;this.render();}),
      events.on('connection.status',status=>{this.connected=status==='connected';if(!this.connected){this.state=null;this.panel.close();}this.render();}),
      events.on('ui.overlay',open=>{this.overlay=open;this.render();}),
    ];
  }
  render() {
    const players=this.connected?nearbyRecipients(this.state):[];
    this.button.hidden=!players.length || this.overlay || this.scene.controls.suspended;
    if(!this.panel.open)return;
    if(!this.connected || this.state?.stage!=='running'){this.panel.close();return;}
    const selected=this.fields.recipient.value;
    // Keep a departed recipient selected so updates cannot silently redirect a gift.
    const choices=[...players];
    if(selected && !choices.some(p=>p.player_id===selected))choices.unshift({player_id:selected,name:'Игрок отошёл'});
    this.fields.recipient.replaceChildren(...choices.map(player=>{
      const option=document.createElement('option');option.value=player.player_id;
      option.textContent=player.name || player.username || `Игрок ${player.player_id}`;return option;
    }));
    if(selected)this.fields.recipient.value=selected;
    const available=this.state.inventory?.[this.fields.resource.value] || 0;
    this.fields.amount.max=Math.min(available,this.state.config?.inventory_capacity || 0);
    this.form.querySelector('[type="submit"]').disabled=!this.payload();
    this.status.textContent=`В рюкзаке: ${available}. Вместимость получателя проверяется при передаче.`;
  }
  payload(){return givePayload(this.state,this.fields.recipient.value,this.fields.resource.value,Number(this.fields.amount.value));}
  open(){
    if(!this.connected || this.scene.controls.suspended || !nearbyRecipients(this.state).length)return;
    this.message='';this.scene.controls.clear();this.scene.controls.suspended=true;
    if(document.pointerLockElement)document.exitPointerLock();
    this.panel.showModal();this.events.emit('ui.overlay',true);this.render();this.fields.recipient.focus();
  }
  send(){
    const payload=this.connected && this.payload();if(!payload)return;
    this.message='';this.events.emit('command',{type:'resource.give',payload});
    this.panel.close();this.resume();
  }
  resume(){
    if(this.panel.open)return;
    const suspended=!!document.querySelector('dialog[open]');
    this.scene.controls.suspended=suspended;this.scene.controls.clear();this.events.emit('ui.overlay',suspended);
    if(!suspended && this.connected && !this.disposing)restorePointerLock(this.scene);
  }
  dispose(){this.disposing=true;if(this.panel.open){this.panel.close();this.resume();}this.abort.abort();this.unsubs.forEach(fn=>fn());this.button.remove();this.panel.remove();}
}

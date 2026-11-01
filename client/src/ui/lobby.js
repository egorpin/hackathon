import './lobby.css';
import { PALETTES, defaultProfile, loadProfile, saveProfile, avatarURL } from './profile.js';

export class Lobby {
 constructor({events,transport,scene,preview=false}){
  Object.assign(this,{events,transport,scene,preview});
  this.stage=null;this.worldReady=false;this.connected=false;this.players=[];
  this.abort=new AbortController();this.unsubs=[];
  const button=this.button=document.createElement('button');
  button.className='player-chip';button.hidden=true;
  button.setAttribute('aria-label','Профиль и игроки');button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','player-lobby');button.setAttribute('aria-expanded','false');
  button.innerHTML='<img alt=""><span class="chip-name"></span>';
  document.querySelector('.header-actions').append(button);
  const panel=this.panel=document.createElement('dialog');
  panel.id='player-lobby';panel.className='player-lobby';panel.setAttribute('aria-labelledby','lobby-title');
  panel.innerHTML=`<div class="lobby-shell">
   <div class="lobby-nav"><div><h1 id="lobby-title">Mars Colony</h1></div><button class="lobby-close" aria-label="Закрыть список игроков" hidden>✕</button></div>
   <div class="lobby-content">
    <div class="my-profile"><img class="pilot-avatar" alt="Моя аватарка"><div><strong class="pilot-name"></strong><span>Ваш аккаунт</span></div><button class="edit-profile">Изменить аватар</button></div>
    <div class="players-heading"><h2>Игроки</h2><span class="player-count">0</span></div>
    <ul class="player-list" aria-label="Подключённые игроки"></ul>
    <p class="lobby-hint" role="status" aria-live="polite">Подключаемся к серверу…</p>
    <button class="ready-button" disabled>Готов</button>
    <button class="enter-world" hidden disabled>Вернуться в игру</button>
    <button class="restart-button" hidden>Перезапустить экспедицию</button>
    <p class="preview-label" hidden>Предпросмотр карты. Общего лобби здесь нет.</p>
    <div class="lobby-bottom"><span>WASD — движение · Tab — камера</span><button class="logout-button">Выйти из аккаунта</button></div>
    <p class="lobby-feedback" role="status" aria-live="polite"></p>
   </div>
   <section class="restart-confirm" hidden aria-labelledby="restart-title">
    <h2 id="restart-title">Перезапустить экспедицию?</h2>
    <p>Прогресс экспедиции будет сброшен для всех участников: постройки, ресурсы и кислород вернутся к начальному состоянию. Все игроки вернутся в лобби. Аккаунты сохранятся.</p>
    <p class="restart-feedback" role="alert"></p>
    <div class="restart-actions"><button type="button" class="restart-cancel">Отмена</button><button type="button" class="restart-confirm-button">Перезапустить</button></div>
   </section>
   <section class="profile-editor" hidden aria-labelledby="profile-title"><form>
    <div class="editor-head"><h2 id="profile-title">Аватар профиля</h2><button type="button" class="cancel-profile" aria-label="Отменить изменения аватара">✕</button></div>
    <div class="avatar-editor"><img alt="Предпросмотр аватара"><div><strong class="profile-account"></strong><p>Так вас видят в списке игроков.</p><button type="button" class="shuffle-avatar">Другой вариант</button></div></div>
    <fieldset class="avatar-palette"><legend>Цвет аватара</legend><div class="avatar-colors" role="group" aria-label="Цвет аватара"></div></fieldset>
    <p class="profile-note">Выберите цвет и вариант. Изменения применятся после сохранения.</p>
    <p class="profile-error" role="alert"></p><div class="profile-actions"><button type="button" class="cancel-profile-text">Отмена</button><button type="submit" class="save-profile">Сохранить</button></div>
   </form></section>
  </div>`;
  document.body.append(panel);
  const on=(el,type,fn)=>el.addEventListener(type,fn,{signal:this.abort.signal});
  on(button,'click',()=>this.open());on(this.q('.lobby-close'),'click',()=>this.close());
  on(panel,'cancel',e=>{e.preventDefault();if(!this.q('.restart-confirm').hidden)this.cancelRestart();else if(!this.q('.profile-editor').hidden)this.cancelEdit();else this.close();});
  on(panel,'close',()=>this.resume());
  on(this.q('.ready-button'),'click',()=>this.toggleReady());
  on(this.q('.enter-world'),'click',()=>this.close());
  on(this.q('.restart-button'),'click',()=>this.confirmRestart());
  on(this.q('.restart-cancel'),'click',()=>this.cancelRestart());
  on(this.q('.restart-confirm-button'),'click',()=>this.restart());
  on(this.q('.edit-profile'),'click',()=>this.edit());
  on(this.q('.cancel-profile'),'click',()=>this.cancelEdit());
  on(this.q('.cancel-profile-text'),'click',()=>this.cancelEdit());
  on(this.q('.shuffle-avatar'),'click',()=>{this.draft.variant=(this.draft.variant+1)%10000;this.renderDraft();});
  on(this.q('.profile-editor form'),'submit',e=>{e.preventDefault();this.save();});
  on(this.q('.logout-button'),'click',()=>this.logout());
  const colorNames=['Персиковый','Мятный','Сиреневый','Розовый','Песочный','Голубой'];
  for(let i=0;i<PALETTES.length;i++){
   const color=document.createElement('button');color.type='button';color.style.setProperty('--swatch',PALETTES[i]);color.setAttribute('aria-label',colorNames[i]);color.title=colorNames[i];
   on(color,'click',()=>{this.draft.color=i;this.renderDraft();});this.q('.avatar-colors').append(color);
  }
  this.unsubs.push(
   events.on('world.stage',stage=>{this.worldStage=stage;this.update();}),
   events.on('world.ready',()=>{this.worldReady=true;this.update();}),
   events.on('connection.status',status=>this.connection(status)),
   transport.on('lobby.state',state=>this.receive(state)),
   transport.on('message',message=>{if(!this.restartRequest||message.request_id!==this.restartRequest)return;if(message.type==='action.result'&&!message.payload.ok||message.type==='error'){this.restartRequest=null;this.q('.restart-feedback').textContent=message.payload.code==='FORBIDDEN'?'Перезапуск недоступен для экспедиции с несколькими командами.':'Не удалось перезапустить экспедицию. Попробуйте ещё раз.';this.update();}}),
   transport.on('lobby.error',error=>{this.pending=false;this.q('.lobby-feedback').textContent=error.code==='ALREADY_STARTED'?'Игра уже началась.':'Не удалось изменить готовность. Попробуйте ещё раз.';this.update();}),
   transport.on('session.ready',identity=>{this.setIdentity(identity,false);this.publishProfile();}));
 }
 q(selector){return this.panel.querySelector(selector);}
 setIdentity(identity,open=true){
  if(!identity?.user_id)return;
  const changed=this.identity?.user_id!==identity.user_id;this.identity=identity;
  if(changed){this.cancelEdit(false);let storage;try{storage=localStorage;}catch{}this.profile=loadProfile(identity.user_id,storage);this.players=[];}
  this.renderProfile();this.button.hidden=false;
  this.q('.preview-label').hidden=!this.preview;this.q('.logout-button').hidden=this.preview;
  this.update();if(open||changed)this.open();
 }
 renderProfile(){
  const url=avatarURL(this.identity.user_id,this.profile);
  this.q('.pilot-avatar').src=url;this.button.querySelector('img').src=url;
  this.q('.pilot-name').textContent=this.identity.username;this.button.querySelector('.chip-name').textContent=this.identity.username;
  this.panel.classList.toggle('reduce-motion',this.profile.reducedMotion);
 }
 publishProfile(){
  if(!this.preview&&this.identity)this.transport.send({type:'lobby.profile',payload:{color:this.profile.color,variant:this.profile.variant}});
 }
 receive(state){
  this.players=state.players;this.stage=state.stage;this.pending=false;
  if(state.stage==='lobby'){this.entered=false;this.restartRequest=null;this.cancelRestart(false);this.open();}
  this.renderPlayers();this.update();
 }
 renderPlayers(){
  const rows=this.players.map(player=>{
   const row=document.createElement('li');row.className='player-row';row.dataset.userId=player.user_id;
   const avatar=document.createElement('img');avatar.alt='';
   avatar.src=avatarURL(player.user_id,player.avatar||defaultProfile(player.user_id));
   const name=document.createElement('span');name.className='player-name';name.textContent=player.username+(player.user_id===this.identity?.user_id?' (вы)':'');
   const status=document.createElement('span');status.className='ready-status'+(player.ready?' is-ready':'');
   status.textContent=player.ready?'Готов':'Не готов';
   row.append(avatar,name,status);return row;
  });
  this.q('.player-list').replaceChildren(...rows);this.q('.player-count').textContent=String(rows.length);
 }
 toggleReady(){
  if(this.pending)return;
  const mine=this.players.find(player=>player.user_id===this.identity?.user_id);
  if(!mine)return;
  this.pending=true;this.q('.lobby-feedback').textContent='';this.update();
  if(!this.transport.send({type:'lobby.ready',payload:{ready:!mine.ready}})){this.pending=false;this.update();}
 }
 update(){
  const running=this.stage==='running'&&this.worldStage==='running'&&this.worldReady;
  const canLeave=this.preview||running;
  this.q('.lobby-close').hidden=!canLeave;
  this.q('.ready-button').hidden=this.preview||this.stage==='running';
  this.q('.enter-world').hidden=!canLeave;this.q('.enter-world').disabled=!this.worldReady;
  this.q('.enter-world').textContent=this.preview?'Открыть карту':'Вернуться в игру';
  this.q('.restart-button').hidden=this.preview||!running;
  this.q('.restart-button').disabled=!this.connected||!!this.restartRequest;
  this.q('.restart-confirm-button').disabled=!this.connected||!!this.restartRequest;
  this.q('.restart-cancel').disabled=!!this.restartRequest;
  this.q('.restart-confirm-button').textContent=this.restartRequest?'Перезапуск…':'Перезапустить';
  const mine=this.players.find(player=>player.user_id===this.identity?.user_id);
  this.q('.ready-button').disabled=!this.connected||!this.worldReady||!mine||this.pending;
  this.q('.ready-button').textContent=this.pending?'Подтверждение…':mine?.ready?'Отменить готовность':'Готов';
  const count=this.players.filter(player=>player.ready).length;
  this.q('.lobby-hint').textContent=this.preview?'Просмотр без подключения к другим игрокам.':!this.connected?'Подключаемся к серверу…':!this.worldReady?'Загружаем игру…':this.stage==='running'?'Игра началась.':`Готовы ${count} из ${this.players.length}. Игра начнётся, когда будут готовы все.`;
  if(running&&!this.entered){this.entered=true;this.close();}
 }
 open(){
  if(!this.identity)return;
  clearTimeout(this.closeTimer);
  if(document.pointerLockElement)document.exitPointerLock();
  this.scene.controls.suspended=true;this.scene.controls.clear();this.events.emit('ui.overlay',true);
  const wasOpen=this.panel.open;
  if(!wasOpen)this.panel.showModal();
  this.panel.classList.remove('is-leaving');this.button.setAttribute('aria-expanded','true');
  if(!wasOpen)this.q('.edit-profile').focus();
 }
 close(){
  if(!this.panel.open||(!this.preview&&!(this.stage==='running'&&this.worldStage==='running'&&this.worldReady)))return;
  this.panel.classList.add('is-leaving');clearTimeout(this.closeTimer);
  this.closeTimer=setTimeout(()=>{this.cancelEdit(false);this.panel.close();},this.profile?.reducedMotion?0:140);
 }
 resume(){const suspended=[...document.querySelectorAll('dialog[open]')].some(panel=>panel!==this.panel);this.scene.controls.suspended=suspended;this.scene.controls.clear();this.button.setAttribute('aria-expanded','false');this.events.emit('ui.overlay',suspended);}
 confirmRestart(){
  if(this.preview||this.stage!=='running'||this.worldStage!=='running'||!this.worldReady||!this.connected)return;
  this.q('.restart-feedback').textContent='';this.q('.restart-confirm').hidden=false;this.panel.classList.add('is-confirming');
  this.panel.setAttribute('aria-labelledby','restart-title');this.q('.lobby-content').inert=true;this.q('.lobby-nav').inert=true;this.q('.restart-cancel').focus();
 }
 cancelRestart(focus=true){
  if(this.restartRequest&&focus)return;
  if(this.q('.restart-confirm').hidden)return;
  this.q('.restart-confirm').hidden=true;this.panel.classList.remove('is-confirming');this.panel.setAttribute('aria-labelledby','lobby-title');
  this.q('.lobby-content').inert=false;this.q('.lobby-nav').inert=false;if(focus)this.q('.restart-button').focus();
 }
 restart(){
  if(this.restartRequest)return;
  try{this.restartRequest=this.transport.command('world.restart',{});this.update();}
  catch(error){this.q('.restart-feedback').textContent=error.message;}
 }
 edit(){
  this.draft={...this.profile};
  this.q('.profile-account').textContent=this.identity.username;this.q('.lobby-feedback').textContent='';this.panel.setAttribute('aria-labelledby','profile-title');
  this.q('.profile-error').textContent='';this.q('.profile-editor').hidden=false;this.panel.classList.add('is-editing');
  this.q('.lobby-content').inert=true;this.q('.lobby-nav').inert=true;this.renderDraft();this.q('.shuffle-avatar').focus();
 }
 cancelEdit(focus=true){this.draft=null;this.panel.setAttribute('aria-labelledby','lobby-title');this.panel.classList.remove('is-editing');this.q('.profile-editor').hidden=true;this.q('.lobby-content').inert=false;this.q('.lobby-nav').inert=false;if(focus)this.q('.edit-profile').focus();}
 renderDraft(){
  this.q('.avatar-editor img').src=avatarURL(this.identity.user_id,this.draft);
  [...this.q('.avatar-colors').children].forEach((el,i)=>el.setAttribute('aria-pressed',String(i===this.draft.color)));
  this.q('.save-profile').disabled=this.draft.color===this.profile.color&&this.draft.variant===this.profile.variant;
 }
 save(){
  try{this.profile=saveProfile(this.identity.user_id,this.draft,localStorage);this.renderProfile();this.publishProfile();this.cancelEdit();this.q('.lobby-feedback').textContent='Аватар сохранён.';}
  catch{this.q('.profile-error').textContent='Браузер запретил сохранение. Разрешите локальное хранилище и повторите.';}
 }
 connection(status){
  this.connected=status==='connected';
  if(!this.connected){this.worldReady=false;this.worldStage=null;this.stage=null;this.pending=false;this.entered=false;this.players=[];this.cancelRestart(false);this.renderPlayers();if(this.identity)this.open();}
  this.update();
  if(status==='world_unavailable')this.panel.close();
  if(status==='unauthorized'){this.panel.close();this.button.hidden=true;this.identity=null;}
 }
 async logout(){
  const button=this.q('.logout-button');button.disabled=true;
  try{
   const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
   if(!response.ok)throw Error('Не удалось выйти. Повторите попытку.');
   this.transport.close();location.reload();
  }catch(error){this.q('.lobby-feedback').textContent=error.message;button.disabled=false;}
 }
 dispose(){clearTimeout(this.closeTimer);this.abort.abort();this.unsubs.forEach(fn=>fn());this.resume();this.panel.remove();this.button.remove();}
}

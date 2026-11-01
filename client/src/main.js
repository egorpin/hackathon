import './style.css';
import { Lobby } from './ui/lobby.js';
import { Assistant } from './ui/assistant.js';
import { Events } from './net/events.js';
import { GameClient } from './net/client.js';
import { Runtime } from './net/runtime.js';
import { WorldScene } from './scene/world-scene.js';
import { BUILDINGS } from './ui/buildings.js';
import { Settings } from './ui/settings.js';
import { RoverUI } from './ui/rover.js';
import { EconomyHUD } from './ui/economy-hud.js';
import { AimResources } from './ui/aim-resources.js';
import { Soundscape } from './audio/soundscape.js';
import { inInteractionRange } from './ui/interaction.js';
import { recipeFor, formatResources, missingResources, canAfford, MINABLE_RESOURCES } from './ui/economy.js';

const root = document.querySelector('main');
root.innerHTML = `
  <div id="viewport"></div>
  <header><div class="brand" id="connection" role="status" data-connected="false" aria-label="ОЖИДАНИЕ СЕТИ"><div class="brand-title"><span class="network-dot" aria-hidden="true"></span>MARS</div><span class="brand-subtitle">COLONY / ЭКСПЕДИЦИЯ 01</span><span id="network-wait">ОЖИДАНИЕ СЕТИ</span></div><div class="header-actions"></div></header>
  <aside id="telemetry" aria-label="Показатели производительности" hidden><p id="performance" hidden>FPS: —</p><p id="performance-detail" hidden>Кадр p95: — · Треугольники: — · Вызовы: —</p><p id="cache" hidden>Данные мира: ожидание манифеста</p></aside>
  <section class="build-dock" aria-label="Строительство">
    <div id="build-hotbar" role="group" aria-label="Выбор постройки, клавиши 1–5">${BUILDINGS.map((building,index)=>`<button type="button" class="build-slot" data-building="${building.type}" aria-pressed="false" aria-label="${index+1} · ${building.name}" title="${building.description}"><kbd>${index+1}</kbd><span class="build-icon" aria-hidden="true">${building.icon}</span><span class="build-name">${building.name}</span><span class="build-cost">—</span></button>`).join('')}<button type="button" id="build-rover" class="build-slot" title="Покупка ровера в офисе"><span class="build-icon" aria-hidden="true">▣</span><span class="build-name">Ровер</span><span class="build-cost">Офис</span></button></div>
    <div id="build-context" hidden><p id="build-info" hidden>Выберите постройку</p><div class="build-actions"><button id="build">Построить</button><button id="build-cancel" aria-label="Отменить выбор постройки">Отмена · Esc</button></div></div>
  </section>
  <div id="crosshair" aria-hidden="true">+</div><div id="crosshair-hint" aria-live="off"></div>
  <aside id="notice" role="status" aria-live="polite" hidden></aside>
  <section id="auth" class="auth" aria-labelledby="auth-title" hidden>
    <form id="auth-form">
      <span class="eyebrow">ЗАЩИЩЁННОЕ ПОДКЛЮЧЕНИЕ</span><h2 id="auth-title">Вход в экспедицию</h2>
      <label>Имя игрока<input name="username" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]+" required></label>
      <label>Пароль<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required></label>
      <p id="auth-error" role="alert" aria-live="polite"></p>
      <div class="auth-actions"><button type="submit" value="login">Войти</button><button type="submit" value="register">Создать игрока</button></div>
    </form>
  </section>
  <span id="environment" hidden></span>
`;
const events = new Events();
let noticeTimer;
const show = (id,text) => {
  const element=document.getElementById(id);element.textContent=text;
  if(id==='notice'){
    element.hidden=!text;clearTimeout(noticeTimer);
    if(text)noticeTimer=setTimeout(()=>{element.hidden=true;},5000);
  }
};
let totalChunks=0;
let gameState=null, selection=null, cameraMode='first', connected=false;
let selectedBuilding=null, aimedId=null;
let selectionHelp='';
const buildingNames=Object.fromEntries(BUILDINGS.map(({type,name})=>[type,name]));
const costFor=type=>recipeFor(gameState,type);
function updateBuildInfo(){
  for(const button of document.querySelectorAll('.build-slot[data-building]')){
    const cost=costFor(button.dataset.building);
    button.querySelector('.build-cost').textContent=cost?formatResources(cost,true):'—';
    button.title=`${buildingNames[button.dataset.building]} · ${cost?formatResources(cost):'ожидание рецепта'}`;
    button.classList.toggle('is-unaffordable',!!cost&&!canAfford(gameState,button.dataset.building));
  }
  const type=selectedBuilding, cost=costFor(type);
  document.getElementById('build-context').hidden=!type;
  if(!type){show('build-info','Выберите постройку: 1–5');return;}
  if(!cost||!gameState?.team_storage){show('build-info',`Стоимость ${buildingNames[type]||'постройки'}: ожидание состояния`);return;}
  let detail=`${buildingNames[type]||'Постройка'}: ${formatResources(cost)} из общего запаса`;
  const missing=missingResources(gameState,type);
  if(Object.keys(missing).length) detail+=` · не хватает ${formatResources(missing)}`;
  if(type==='oxygen_generator' && gameState?.config?.oxygen_enabled===false) detail+=' · производство O₂ отключено';
  show('build-info',detail);
}
function updateSelection(){
  const {cell,locallyAllowed}=selection||{};
  document.getElementById('build').disabled=!connected || gameState?.stage!=='running' || !selectedBuilding || !cell || !locallyAllowed || !canAfford(gameState,selectedBuilding);
  if(!selectedBuilding){selectionHelp='';updateCrosshairHint();return;}
  if(!cell){selectionHelp='Выберите свободную клетку рядом с персонажем.';updateCrosshairHint();return;}
  const type=selectedBuilding, cost=costFor(type), missing=missingResources(gameState,type);
  let reason='';
  if(!connected) reason='Ожидание соединения с сервером.';
  else if(!cost||missing===null) reason='Ожидание рецептов и общего запаса.';
  else if(!cell.buildable) reason='На этой клетке строить нельзя.';
  else if(type==='drill'&&!MINABLE_RESOURCES.includes(cell.resource)) reason='Для бура выберите месторождение железа, меди, льда или серы.';
  else if(gameState?.buildings?.some(item=>item.cell_id===cell.cell_id)) reason='Клетка занята постройкой; выберите соседнюю.';
  else if(Object.keys(missing).length) reason=`В общем запасе не хватает: ${formatResources(missing)}.`;
  else if(!locallyAllowed) reason='Подойдите ближе к клетке, чтобы строить.';
  else reason=`ЛКМ · построить · ${formatResources(cost)}.`;
  selectionHelp=reason;
  updateCrosshairHint();
}
function updateCrosshairHint(){
  const hint=document.getElementById('crosshair-hint'); hint.hidden=cameraMode!=='first';
  if(hint.hidden)return;
  if(gameState?.stage!=='running'){hint.textContent='Ожидайте начала экспедиции';return;}
  if(!selectedBuilding){const building=gameState?.buildings?.find(item=>item.building_id===aimedId);hint.textContent=connected && building && inInteractionRange(gameState,building)?'E · постройка':'';return;}
  if(!selection?.cell){hint.textContent='Наведитесь на клетку для установки';return;}
  hint.textContent=selectionHelp;
}
function explainAction(result){
  if(result.ok)return 'Готово.';
  const explanations={
    OUT_OF_RANGE:'Подойдите ближе к выбранной клетке или постройке.',
    CELL_OCCUPIED:'Клетка или место рядом с игроком заняты. Выберите свободную клетку.',
    CELL_UNBUILDABLE:'На этой клетке строить нельзя. Выберите другую поверхность.',
    RESOURCE_REQUIRED:'Бур ставится только на месторождение железа, меди, льда или серы.',
    INSUFFICIENT_RESOURCES:'В общем запасе недостаточно ресурсов. Проверьте стоимость постройки.',
    NOT_STARTED:'Экспедиция ещё не началась.',
    LANDING_REQUIRED:'Сначала все участники должны выбрать посадочную площадку.',
    ALREADY_STARTED:'Экспедиция уже началась.',
    FORBIDDEN:'Это действие доступно только участникам вашей команды.',
    INVENTORY_FULL:'Нет места в инвентаре. Освободите место и повторите.',
    SPAWN_BLOCKED:'Рядом с местом назначения нет свободного места.',
    TARGET_UNAVAILABLE:'Игрок недоступен для телепортации.',
    READY_REQUIRED:'Все участники должны подтвердить готовность к экспедиции.',
    REQUEST_CONFLICT:'Этот запрос уже использован с другим содержимым. Повторите действие.',
    NOT_IMPLEMENTED:'Это действие пока недоступно.',
    NOT_READY:'Дождитесь синхронизации состояния мира.',
    WORLD_UNAVAILABLE:'Не удалось войти в мир. Проверьте доступ к экспедиции.',
    PREVIEW_ONLY:'В режиме просмотра игровые действия отключены.',
    INVALID_ARGUMENT:'Проверьте выбранное действие и его параметры.',
    OFFICE_REQUIRED:'Подойдите к офису в куполе.',
    SURVEY_LIMIT:'Блокнот заполнен.', SURVEY_REQUIRED:'Сначала запишите эти координаты в поле.',
    POINT_EXISTS:'Константа с таким именем уже существует.', POINT_LIMIT:'Реестр точек заполнен.',
    ROVER_LIMIT:'Достигнут предел количества роверов.', ROVER_RUNNING:'Сначала остановите ровер.',
    REVISION_CONFLICT:'Программа изменилась у другого игрока. Обновите её перед сохранением.',
    PROGRAM_TOO_LONG:'Программа превышает допустимый размер.', INVALID_PROGRAM:'Ошибка в программе. Проверьте команды и структуру цикла.',
    UNKNOWN_POINT:'В программе указана неизвестная константа.',
  };
  const message=explanations[result.code]||`Действие отклонено сервером: ${result.code||'неизвестная ошибка'}.`;
  return Number.isInteger(result.line) ? `${message} Строка ${result.line}.` : message;
}
events.on('notice', text=>show('notice',text));
function setConnection(status){
  connected=status==='connected';
  if(!connected){gameState=null;selection=null;updateBuildInfo();}
  const indicator=document.getElementById('connection');
  indicator.dataset.connected=String(connected);
  indicator.setAttribute('aria-label',connected?'Сеть доступна':'ОЖИДАНИЕ СЕТИ');
  document.getElementById('network-wait').hidden=connected;
  updateSelection();
}
events.on('connection.status',setConnection);
events.on('cache.stats', s=>show('cache',`Активные чанки: ${s.chunks} / ${totalChunks || '—'} · мир: ${s.percent.toFixed(2)}% / 10% · состояние: ${s.stateBytes}\u00a0Б · очередь: ${s.queuedBytes}\u00a0Б`));
events.on('world.ready', ({totalChunks:count})=>{ totalChunks=count; });
events.on('performance', s=>{
  show('performance',`FPS: ${Math.round(s.fps)}`);
  const p95=Number.isFinite(s.frameP95)?`${s.frameP95.toFixed(1)} мс`:'—';
  const triangles=Number.isFinite(s.triangles)?s.triangles.toLocaleString('ru-RU'):'—';
  show('performance-detail',`Кадр p95: ${p95} · Треугольники: ${triangles} · Вызовы: ${s.drawCalls}`);
});
events.on('world.state',state=>{gameState=state;updateBuildInfo();updateSelection();});
events.on('building.targeted', building=>{aimedId=building?.building_id;updateCrosshairHint();});
events.on('cell.selected', value=>{selection=value;updateSelection();});
events.on('camera.changed', mode=>{cameraMode=mode;document.getElementById('crosshair').hidden=mode!=='first';updateCrosshairHint();});
events.on('action.result', result=>show('notice',explainAction(result)));
document.getElementById('build').onclick=()=>events.emit('build.request');
events.on('build.choose',type=>{
  selectedBuilding=type===selectedBuilding?null:type;
  root.classList.toggle('is-building',!!selectedBuilding);
  for(const button of document.querySelectorAll('.build-slot'))button.setAttribute('aria-pressed',String(button.dataset.building===selectedBuilding));
  events.emit('build.type',selectedBuilding);
  updateBuildInfo();updateSelection();
});
events.on('build.cancel',()=>{
  if(!document.querySelector('#assistant-panel:not([hidden])'))events.emit('build.choose',null);
});
events.on('expedition.lobby',()=>{selection=null;events.emit('build.choose',null);});
for(const button of document.querySelectorAll('.build-slot[data-building]'))button.onclick=()=>events.emit('build.choose',button.dataset.building);
document.getElementById('build-cancel').onclick=()=>{events.emit('build.choose',null);document.querySelector('#build-hotbar button').focus();};
try {
  const scene=new WorldScene(document.getElementById('viewport'),events);
  const sound=new Soundscape({events});
  const settings=new Settings({events,scene});
  const economy=new EconomyHUD({events,scene});
  const rover=new RoverUI({events,scene});
  settings.button.before(rover.button);
  const pickup=new AimResources({events,scene});
  let transport;
  if(import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) {
    const {createFixture}=await import('./scene/fixture.js'); transport=createFixture();
    show('environment','GOLDBERG · ПРОСМОТР ГЕОМЕТРИИ · НЕ МУЛЬТИПЛЕЕР');
    document.getElementById('environment').hidden=false;
  } else transport=new GameClient();
  const runtime=new Runtime(transport,scene,events);
  const lobby=new Lobby({events,transport,scene,preview:import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')});
  const assistant=new Assistant({events,scene});
  // Participant 4 integration surface: subscribe to events; send intentions via command().
  window.marsClient={events,command:(type,payload)=>runtime.command(type,payload),toggleCamera:()=>events.emit('camera.toggle'),dispose:()=>runtime.dispose()};
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) { lobby.setIdentity({user_id:'preview-explorer',username:'Explorer',world_id:'Марс / просмотр'}); transport.connect(); }
  else authenticate(transport,lobby);
  window.addEventListener('pagehide',()=>{sound.dispose();assistant.dispose();pickup.dispose();rover.dispose();economy.dispose();settings.dispose();lobby.dispose();runtime.dispose();},{once:true});
  if(import.meta.hot) import.meta.hot.dispose(()=>{sound.dispose();assistant.dispose();pickup.dispose();rover.dispose();economy.dispose();settings.dispose();lobby.dispose();runtime.dispose();});
} catch(error) { show('notice',`Не удалось запустить 3D: ${error.message}`); }

async function authenticate(transport,lobby) {
  const panel=document.getElementById('auth');
  const form=document.getElementById('auth-form');
  const error=document.getElementById('auth-error');
  const openSocket=(identity)=>{ panel.hidden=true; lobby.setIdentity(identity); transport.connect(); };
  transport.on('status', status=>{
    if(status==='unauthorized') { panel.hidden=false; setConnection(status); }
    if(status==='world_unavailable') {
      panel.hidden=false;
      error.textContent=transport.worldUnavailableReason==='World is full'
        ?'В экспедиции уже четыре игрока. Участники могут войти под своими аккаунтами.'
        :'Не удалось войти в мир. Проверьте доступ к экспедиции и попробуйте снова.';
    }
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault(); error.textContent='';
    const submitter=event.submitter?.value==='register'?'register':'login';
    const fields=new FormData(form);
    const buttons=[...form.querySelectorAll('button')]; buttons.forEach(button=>button.disabled=true);
    try {
      const response=await fetch(`/api/auth/${submitter}`,{
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:fields.get('username'),password:fields.get('password')})
      });
      if(!response.ok) {
        const body=await response.json().catch(()=>({}));
        const messages={401:'Неверное имя или пароль.',409:'Такое имя уже занято.',422:'Проверьте имя и длину пароля.'};
        throw new Error(messages[response.status] || body.detail || `HTTP ${response.status}`);
      }
      const identity=await response.json(); form.reset(); openSocket(identity);
    } catch(cause) { error.textContent=cause.message; }
    finally { buttons.forEach(button=>button.disabled=false); }
  });
  try {
    const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'});
    if(response.ok){ openSocket(await response.json()); return; }
    if(response.status!==401) throw new Error(`HTTP ${response.status}`);
  } catch (cause) {
    error.textContent=`Сервер авторизации недоступен: ${cause.message}`;
  }
  panel.hidden=false; setConnection('unauthorized');
}

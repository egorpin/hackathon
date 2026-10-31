import './style.css';
import { Events } from './net/events.js';
import { GameClient } from './net/client.js';
import { Runtime } from './net/runtime.js';
import { WorldScene } from './scene/world-scene.js';

const root = document.querySelector('main');
root.innerHTML = `
  <div id="viewport"></div>
  <header><div class="brand">MARS<span>COLONY / ЭКСПЕДИЦИЯ 01</span></div><button id="panel-toggle" aria-expanded="true" aria-controls="instruments">Скрыть панель · H</button><div id="connection" role="status">Подключение…</div></header>
  <section class="instrument" id="instruments"><span class="eyebrow">ТЕЛЕМЕТРИЯ ЭКСПЕДИЦИИ</span><h1>Поверхность Марса</h1>
    <p id="mode">Камера: первое лицо</p><p id="cache">Данные мира: ожидание манифеста</p><p id="performance" aria-live="off">FPS: —</p><p id="performance-detail" aria-live="off">Кадр p95: — · Треугольники: — · Вызовы: —</p>
    <p id="inventory">Ресурсы: ожидание состояния</p>
    <p id="selection">Наведитесь на клетку</p><p id="selection-help">Выберите свободную клетку рядом с персонажем.</p>
    <p id="build-info">Стоимость постройки: ожидание состояния</p>
    <div class="actions"><button id="camera">Сменить камеру · Tab</button>
    <button id="start" hidden>Начать экспедицию</button>
    <label class="setting">Качество графики<select id="quality" aria-label="Качество графики"><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label>
    <label class="setting setting-check"><input id="camera-bob" type="checkbox"> Покачивание камеры</label>
    <select id="building" aria-label="Тип постройки"><option value="drill">Бур</option><option value="oxygen_generator">Генератор O₂ (кислород)</option><option value="warehouse">Склад</option></select>
    <fieldset class="color-picker" aria-label="Цвет игрока и построек"><legend>Цвет игрока и построек</legend><div id="colors" role="radiogroup" aria-label="Цвет игрока и построек"></div></fieldset>
    <button id="build">Построить · B</button></div>
  </section>
  <div id="crosshair" aria-hidden="true">+</div><div id="crosshair-hint" aria-live="off"></div>
  <aside id="notice" role="status" aria-live="polite">Ожидание серверного состояния. WASD — движение, мышь или стрелки — взгляд.</aside>
  <section id="auth" class="auth" aria-labelledby="auth-title" hidden>
    <form id="auth-form">
      <span class="eyebrow">ЗАЩИЩЁННОЕ ПОДКЛЮЧЕНИЕ</span><h2 id="auth-title">Вход в экспедицию</h2>
      <label>Имя игрока<input name="username" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]+" required></label>
      <label>Пароль<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required></label>
      <p id="auth-error" role="alert" aria-live="polite"></p>
      <div class="auth-actions"><button type="submit" value="login">Войти</button><button type="submit" value="register">Создать игрока</button></div>
    </form>
  </section>
  <footer><span>WASD · движение &nbsp; Shift · бег &nbsp; Space · прыжок &nbsp; F · фонарик &nbsp; E · действие &nbsp; Esc · мышь</span><span id="environment">ЛОКАЛЬНАЯ СЕТЬ</span></footer>
`;
const events = new Events();
const panelToggle=document.getElementById('panel-toggle');
panelToggle.onclick=()=>{const panel=document.getElementById('instruments');panel.hidden=!panel.hidden;panelToggle.setAttribute('aria-expanded',String(!panel.hidden));panelToggle.textContent=panel.hidden?'Показать панель · H':'Скрыть панель · H';};
document.addEventListener('keydown',event=>{if(event.code==='KeyH' && !event.repeat && !event.target?.closest?.('input,textarea,select,[contenteditable=true]'))panelToggle.click();});
const show = (id,text) => { document.getElementById(id).textContent=text; };
let totalChunks=0;
let gameState=null, selection=null, cameraMode='first';
const buildingSelect=document.getElementById('building');
const buildingNames={drill:'Бур',warehouse:'Склад',oxygen_generator:'Генератор O₂'};
const resourceNames={water:'лёд',ice:'лёд',iron:'железо',sulfur:'сера',stone:'камень',ore:'руда',oxygen:'кислород'};
const costFor=type=>gameState?.config?.recipes?.[type];
function updateInventory(){
  const inventory=gameState?.inventory;
  if(!inventory){show('inventory','Ресурсы: ожидание состояния');return;}
  const items=['ore','water','iron','sulfur','stone','oxygen'].filter(key=>Object.hasOwn(inventory,key));
  show('inventory',`Ресурсы: ${items.map(key=>`${resourceNames[key]||key} ${inventory[key]}`).join(' · ') || 'нет данных'}`);
}
function updateBuildInfo(){
  const type=buildingSelect.value, cost=costFor(type), ore=gameState?.inventory?.ore;
  if(!Number.isFinite(cost)||!Number.isFinite(ore)){show('build-info',`Стоимость ${buildingNames[type]||'постройки'}: ожидание состояния`);return;}
  let detail=`${buildingNames[type]||'Постройка'}: ${cost} руды · у вас ${ore}`;
  if(ore<cost) detail+=` · не хватает ${cost-ore}`;
  if(type==='oxygen_generator' && gameState?.config?.oxygen_enabled===false) detail+=' · производство O₂ отключено';
  show('build-info',detail);
}
function updateSelection(){
  const {cell,locallyAllowed}=selection||{};
  if(!cell){show('selection','Наведитесь на клетку');show('selection-help','Выберите свободную клетку рядом с персонажем.');updateCrosshairHint();return;}
  const kind=cell.resource?resourceNames[cell.resource]||'ресурс':'без жилы';
  const type=buildingSelect.value, cost=costFor(type), ore=gameState?.inventory?.ore;
  let reason='';
  if(!cell.buildable) reason='На этой клетке строить нельзя.';
  else if(type==='drill'&&!cell.resource) reason='Для бура выберите клетку с рудной жилой.';
  else if(gameState?.buildings?.some(item=>item.cell_id===cell.cell_id)) reason='Клетка занята постройкой; выберите соседнюю.';
  else if(Number.isFinite(cost)&&Number.isFinite(ore)&&ore<cost) reason=`Не хватает руды: нужно ${cost}, у вас ${ore}.`;
  else if(!locallyAllowed) reason='Подойдите ближе к клетке, чтобы строить.';
  else reason=`Построить · B · стоимость ${cost} руды.`;
  show('selection',`Клетка ${cell.cell_id} · ${kind}`);
  show('selection-help',reason);
  updateCrosshairHint();
}
function updateCrosshairHint(){
  const hint=document.getElementById('crosshair-hint'); hint.hidden=cameraMode!=='first';
  if(hint.hidden)return;
  if(gameState?.stage!=='running'){hint.textContent='Ожидайте начала экспедиции';return;}
  if(!selection?.cell){hint.textContent='Наведитесь на клетку · B построить';return;}
  hint.textContent=document.getElementById('selection-help').textContent;
}
function explainAction(result){
  if(result.ok)return 'Готово.';
  const explanations={
    OUT_OF_RANGE:'Подойдите ближе к выбранной клетке или постройке.',
    CELL_OCCUPIED:'Клетка или место рядом с игроком заняты. Выберите свободную клетку.',
    CELL_UNBUILDABLE:'На этой клетке строить нельзя. Выберите другую поверхность.',
    RESOURCE_REQUIRED:'Бур ставится только на клетку с рудной жилой.',
    INSUFFICIENT_RESOURCES:`Не хватает руды для постройки. ${document.getElementById('build-info').textContent}.`,
    NOT_STARTED:'Экспедиция ещё не началась.',
    LANDING_REQUIRED:'Сначала все участники должны выбрать посадочную площадку.',
    ALREADY_STARTED:'Экспедиция уже началась.',
    FORBIDDEN:'Это действие доступно только участникам вашей команды.',
    INVENTORY_FULL:'Нет места в инвентаре. Освободите место и повторите.',
    REQUEST_CONFLICT:'Этот запрос уже использован с другим содержимым. Повторите действие.',
    NOT_IMPLEMENTED:'Это действие пока недоступно.',
    NOT_READY:'Дождитесь синхронизации состояния мира.',
    WORLD_UNAVAILABLE:'Мир заполнен или уже запущен. Войдите существующим игроком.',
    PREVIEW_ONLY:'В режиме просмотра игровые действия отключены.',
    INVALID_ARGUMENT:'Проверьте выбранное действие и его параметры.',
  };
  return explanations[result.code]||`Действие отклонено сервером: ${result.code||'неизвестная ошибка'}.`;
}
events.on('notice', text=>show('notice',text));
events.on('connection.status', status=>{
  const names={connecting:'Подключение…',syncing:'Синхронизация…',connected:'Подключено',reconnecting:'Нет связи · переподключение',unauthorized:'Требуется вход через сервер',world_unavailable:'Мир недоступен'};
  show('connection',names[status] || status);
});
events.on('cache.stats', s=>show('cache',`Чанки: ${s.chunks} / ${totalChunks || '—'} · данные: ${s.percent.toFixed(2)}% · предел: 10% · очередь: ${s.queuedBytes} Б`));
events.on('world.ready', ({totalChunks:count})=>{ totalChunks=count; show('notice','Щёлкните по сцене для захвата мыши. Tab переключает камеру.'); });
events.on('performance', s=>{
  show('performance',`FPS: ${Math.round(s.fps)} · вызовы отрисовки: ${s.drawCalls}`);
  const p95=Number.isFinite(s.frameP95)?`${s.frameP95.toFixed(1)} мс`:'—';
  const triangles=Number.isFinite(s.triangles)?s.triangles.toLocaleString('ru-RU'):'—';
  show('performance-detail',`Кадр p95: ${p95} · Треугольники: ${triangles} · Вызовы: ${s.drawCalls}`);
});
events.on('world.snapshot',state=>{gameState=state;updateInventory();updateBuildInfo();updateSelection();});
events.on('world.delta',delta=>{if(gameState)gameState={...gameState,...delta};updateInventory();updateBuildInfo();updateSelection();});
events.on('cell.selected', value=>{selection=value;updateSelection();});
events.on('camera.changed', mode=>{cameraMode=mode;show('mode',mode==='first'?'Камера: первое лицо':'Камера: сверху · прежний радиус обзора');document.getElementById('crosshair').hidden=mode!=='first';updateCrosshairHint();});
events.on('action.result', result=>show('notice',explainAction(result)));
events.on('building.selected', building=>show('notice',building ? `Выбрано: ${building.building_id}. Подойдите ближе для работы с ресурсами.`:'Рядом нет доступных построек.'));
document.getElementById('camera').onclick=()=>events.emit('camera.toggle');
document.getElementById('build').onclick=()=>events.emit('build.request');
document.getElementById('start').onclick=()=>events.emit('command',{type:'world.start',payload:{}});
events.on('world.stage', stage=>{ document.getElementById('start').hidden=stage!=='lobby'; });
buildingSelect.onchange=e=>{events.emit('build.type',e.target.value);updateBuildInfo();updateSelection();};
const playerColors=[['#ff6b4a','Красный'],['#ffbd4a','Жёлтый'],['#a7d94b','Лаймовый'],['#42d6a4','Бирюзовый'],['#42b8ff','Голубой'],['#687bff','Синий'],['#bd70ff','Фиолетовый'],['#ff75b8','Розовый']];
const colorGroup=document.getElementById('colors');
for(const [color,label] of playerColors){
  const button=document.createElement('button'); button.type='button'; button.className='color-choice'; button.setAttribute('role','radio');
  button.setAttribute('aria-label',label); button.setAttribute('aria-checked','false'); button.dataset.color=color;
  button.style.setProperty('--swatch',color); button.title=label;
  button.onclick=()=>events.emit('command',{type:'player.color',payload:{color}});
  button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const buttons=[...colorGroup.children],index=buttons.indexOf(button),step=['ArrowRight','ArrowDown'].includes(event.key)?1:-1;buttons[(index+step+buttons.length)%buttons.length].click();buttons[(index+step+buttons.length)%buttons.length].focus();};
  colorGroup.append(button);
}
function selectColor(color){if(!color)return;for(const button of colorGroup.children){const selected=button.dataset.color===color;button.setAttribute('aria-checked',String(selected));button.tabIndex=selected?0:-1;}}
events.on('world.snapshot',state=>selectColor(state.players?.find(p=>p.player_id===state.self_id)?.color));
events.on('world.delta',state=>selectColor(state.players?.find(p=>p.player_id===state.self_id)?.color));
function readPreference(key,fallback){try{return localStorage.getItem(key) ?? fallback;}catch{return fallback;}}
function savePreference(key,value){try{localStorage.setItem(key,value);}catch{/* Storage can be disabled by browser policy. */}}
const qualitySelect=document.getElementById('quality');
const savedQuality=readPreference('mars.graphics.quality','medium');
qualitySelect.value=['low','medium','high'].includes(savedQuality)?savedQuality:'medium';
const bobToggle=document.getElementById('camera-bob'); bobToggle.checked=readPreference('mars.graphics.bob','true')==='true';
qualitySelect.onchange=()=>{savePreference('mars.graphics.quality',qualitySelect.value);events.emit('graphics.quality',qualitySelect.value);};
bobToggle.onchange=()=>{savePreference('mars.graphics.bob',String(bobToggle.checked));events.emit('graphics.bob',bobToggle.checked);};
try {
  const scene=new WorldScene(document.getElementById('viewport'),events);
  events.emit('graphics.quality',qualitySelect.value);
  events.emit('graphics.bob',bobToggle.checked);
  let transport;
  if(import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) {
    const {createFixture}=await import('./scene/fixture.js'); transport=createFixture();
    show('environment','GOLDBERG · ПРОСМОТР ГЕОМЕТРИИ · НЕ МУЛЬТИПЛЕЕР');
  } else transport=new GameClient();
  const runtime=new Runtime(transport,scene,events);
  // Participant 4 integration surface: subscribe to events; send intentions via command().
  window.marsClient={events,command:(type,payload)=>runtime.command(type,payload),toggleCamera:()=>events.emit('camera.toggle'),dispose:()=>runtime.dispose()};
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) transport.connect();
  else authenticate(transport);
  window.addEventListener('pagehide',()=>runtime.dispose(),{once:true});
  if(import.meta.hot) import.meta.hot.dispose(()=>runtime.dispose());
} catch(error) { show('notice',`Не удалось запустить 3D: ${error.message}`); }

async function authenticate(transport) {
  const panel=document.getElementById('auth');
  const form=document.getElementById('auth-form');
  const error=document.getElementById('auth-error');
  const openSocket=()=>{ panel.hidden=true; transport.connect(); };
  transport.on('status', status=>{
    if(status==='unauthorized') { panel.hidden=false; show('connection','Требуется вход'); }
    if(status==='world_unavailable') {
      panel.hidden=false;
      error.textContent='Мир уже запущен или заполнен. Войдите под именем игрока, который уже участвует в этой экспедиции.';
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
      openSocket();
    } catch(cause) { error.textContent=cause.message; }
    finally { buttons.forEach(button=>button.disabled=false); }
  });
  try {
    const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'});
    if(response.ok){ openSocket(); return; }
    if(response.status!==401) throw new Error(`HTTP ${response.status}`);
  } catch (cause) {
    error.textContent=`Сервер авторизации недоступен: ${cause.message}`;
  }
  panel.hidden=false; show('connection','Требуется вход');
}

import './style.css';
import { Events } from './net/events.js';
import { GameClient } from './net/client.js';
import { Runtime } from './net/runtime.js';
import { WorldScene } from './scene/world-scene.js';

const root = document.querySelector('main');
root.innerHTML = `
  <div id="viewport"></div>
  <header><div class="brand">MARS<span>COLONY / ЭКСПЕДИЦИЯ 01</span></div><div id="connection" role="status">Подключение…</div></header>
  <section class="instrument"><span class="eyebrow">ТЕЛЕМЕТРИЯ ЭКСПЕДИЦИИ</span><h1>Поверхность Марса</h1>
    <p id="mode">Камера: первое лицо</p><p id="cache">Данные мира: ожидание манифеста</p><p id="performance">FPS: —</p>
    <p>В — вода · Ж — железо · С — сера · O₂ — заглушка</p>
    <p id="selection">Наведитесь на клетку</p>
    <div class="actions"><button id="camera">Сменить камеру · Tab</button>
    <button id="start" hidden>Начать экспедицию</button>
    <select id="building" aria-label="Тип постройки"><option value="drill">Бур</option><option value="oxygen_generator">Генератор O₂ (заглушка)</option><option value="warehouse">Склад</option></select>
    <button id="build">Построить · B</button></div>
  </section>
  <div id="crosshair" aria-hidden="true">+</div>
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
  <footer><span>WASD · движение &nbsp; E · взаимодействие &nbsp; Esc · освободить мышь</span><span id="environment">ЛОКАЛЬНАЯ СЕТЬ</span></footer>
`;
const events = new Events();
const show = (id,text) => { document.getElementById(id).textContent=text; };
let totalChunks=0;
events.on('notice', text=>show('notice',text));
events.on('connection.status', status=>{
  const names={connecting:'Подключение…',syncing:'Синхронизация…',connected:'Подключено',reconnecting:'Нет связи · переподключение',unauthorized:'Требуется вход через сервер',world_unavailable:'Мир недоступен'};
  show('connection',names[status] || status);
});
events.on('cache.stats', s=>show('cache',`Чанки: ${s.chunks} / ${totalChunks || '—'} · данные: ${s.percent.toFixed(2)}% · предел: 10% · очередь: ${s.queuedBytes} Б`));
events.on('world.ready', ({totalChunks:count})=>{ totalChunks=count; show('notice','Щёлкните по сцене для захвата мыши. Tab переключает камеру.'); });
events.on('performance', s=>show('performance',`FPS: ${Math.round(s.fps)} · вызовы отрисовки: ${s.drawCalls}`));
events.on('cell.selected', ({cell,locallyAllowed})=>{ show('selection',cell ? `Клетка ${cell.cell_id} · ${{water:'Вода',iron:'Железо',sulfur:'Сера'}[cell.resource] || 'Нет ресурса'} · ${locallyAllowed?'доступна для запроса':'строительство ограничено'}` : 'Наведитесь на клетку'); });
events.on('camera.changed', mode=>{ show('mode',mode==='first'?'Камера: первое лицо':'Камера: сверху · прежний радиус обзора'); document.getElementById('crosshair').hidden=mode!=='first'; });
events.on('action.result', result=>show('notice',result.ok?'Действие подтверждено сервером':`Действие отклонено: ${result.message || result.code}`));
events.on('building.selected', building=>show('notice',building ? `Выбрано: ${building.building_id}. Событие building.selected передано интерфейсу ресурсов.`:'Рядом нет доступных построек.'));
document.getElementById('camera').onclick=()=>events.emit('camera.toggle');
document.getElementById('build').onclick=()=>events.emit('build.request');
document.getElementById('start').onclick=()=>events.emit('command',{type:'world.start',payload:{}});
events.on('world.stage', stage=>{ document.getElementById('start').hidden=stage!=='lobby'; });
document.getElementById('building').onchange=e=>events.emit('build.type',e.target.value);
try {
  const scene=new WorldScene(document.getElementById('viewport'),events);
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

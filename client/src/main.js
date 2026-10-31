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
    <p id="selection">Наведитесь на клетку</p>
    <div class="actions"><button id="camera">Сменить камеру · Tab</button>
    <select id="building" aria-label="Тип постройки"><option value="drill">Бур</option><option value="oxygen_generator">Генератор O₂</option><option value="storage">Склад</option></select>
    <button id="build">Построить · B</button></div>
  </section>
  <div id="crosshair" aria-hidden="true">+</div>
  <aside id="notice" role="status" aria-live="polite">Ожидание серверного состояния. WASD — движение, мышь или стрелки — взгляд.</aside>
  <footer><span>WASD · движение &nbsp; E · взаимодействие &nbsp; Esc · освободить мышь</span><span id="environment">ЛОКАЛЬНАЯ СЕТЬ</span></footer>
`;
const events = new Events();
const show = (id,text) => { document.getElementById(id).textContent=text; };
let totalChunks=0;
events.on('notice', text=>show('notice',text));
events.on('connection.status', status=>{
  const names={connecting:'Подключение…',syncing:'Синхронизация…',connected:'Подключено',reconnecting:'Нет связи · переподключение',unauthorized:'Требуется вход через сервер'};
  show('connection',names[status] || status);
});
events.on('cache.stats', s=>show('cache',`Чанки: ${s.chunks} / ${totalChunks || '—'} · данные: ${s.percent.toFixed(2)}% · предел: 10% · очередь: ${s.queuedBytes} Б`));
events.on('world.ready', ({totalChunks:count})=>{ totalChunks=count; show('notice','Щёлкните по сцене для захвата мыши. Tab переключает камеру.'); });
events.on('performance', s=>show('performance',`FPS: ${Math.round(s.fps)} · вызовы отрисовки: ${s.drawCalls}`));
events.on('cell.selected', ({cell,locallyAllowed})=>{ show('selection',cell ? `Клетка ${cell.cell_id} · ${locallyAllowed?'доступна для запроса':'строительство ограничено'}` : 'Наведитесь на клетку'); });
events.on('camera.changed', mode=>{ show('mode',mode==='first'?'Камера: первое лицо':'Камера: сверху · прежний радиус обзора'); document.getElementById('crosshair').hidden=mode!=='first'; });
events.on('action.result', result=>show('notice',result.ok?'Действие подтверждено сервером':`Действие отклонено: ${result.message || result.code}`));
events.on('building.selected', building=>show('notice',building ? `Выбрано: ${building.building_id}. Событие building.selected передано интерфейсу ресурсов.`:'Рядом нет доступных построек.'));
document.getElementById('camera').onclick=()=>events.emit('camera.toggle');
document.getElementById('build').onclick=()=>events.emit('build.request');
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
  transport.connect();
  window.addEventListener('pagehide',()=>runtime.dispose(),{once:true});
  if(import.meta.hot) import.meta.hot.dispose(()=>runtime.dispose());
} catch(error) { show('notice',`Не удалось запустить 3D: ${error.message}`); }

import "./rover.css";

const fmt = n => Number.isFinite(n) ? n.toFixed(4) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = {idle:'Готов',running:'В пути',waiting:'Ожидает',error:'Ошибка'};
const starter = '# Первая программа: проверка связи\nwait(1)\n';
const storageKey = 'mars.rover.files.v1';

export class RoverUI {
  constructor({events, scene}) {
    Object.assign(this,{events,scene,state:null,selected:null,view:'camera',pendingCommands:new Map(),busy:false});
    this.abort = new AbortController();
    this.button = document.createElement('button');
    this.button.className='rover-toggle'; this.button.textContent='Блокнот / роверы'; this.button.hidden=true;
    document.querySelector('.header-actions').append(this.button);
    this.panel=document.createElement('dialog'); this.panel.className='rover-panel';
    this.panel.innerHTML=`
      <header class="rv-head"><div><small>ЭКСПЕДИЦИЯ / РАБОЧЕЕ ПРОСТРАНСТВО</small><h1>Бортовой блокнот<span>01</span></h1></div><button data-close aria-label="Закрыть блокнот">Закрыть <kbd>Esc</kbd></button></header>
      <main class="rv-workspace">
        <aside class="rv-explorer"><div class="rv-section-title">ФАЙЛЫ <span>ЛОКАЛЬНО</span></div><div class="rv-file-actions"><button data-new-folder>＋ Папка</button><button data-new-file>＋ Файл</button></div><nav data-tree aria-label="Файлы экспедиции"></nav><div class="rv-explorer-note">Файлы сохраняются автоматически в этом браузере.</div></aside>
        <section class="rv-code"><nav class="rv-file-tabs" data-tabs aria-label="Открытые файлы"></nav><div class="rv-toolbar"><label>Имя файла<input data-filename aria-label="Имя файла"></label><div><button data-save>Передать</button><button data-stop>■ Стоп</button><button class="rv-primary" data-run>▶ Запустить</button></div></div><div class="rv-meta"><span data-path></span><span>ROVER SCRIPT</span></div><div class="rv-editor"><div data-lines aria-hidden="true"></div><textarea data-program spellcheck="false" aria-label="Программа ровера"></textarea></div><div class="rv-console"><div class="rv-section-title">ВЫПОЛНЕНИЕ <span data-bytes></span></div><p data-feedback role="status" aria-live="polite">Откройте файл и запустите программу.</p><p data-line></p><details><summary>Команды и пример маршрута</summary><code>DEST = (12.3456, 24.5678)<br>move_to(DEST)<br>wait(1)</code><p>Точки объявляются в начале файла. Команды: move_to(NAME), load(20), unload(), wait(1). Цикл: while true do … end.</p></details></div></section>
        <aside class="rv-mission"><section class="rv-fleet"><div class="rv-section-title">РОВЕР <button data-purchase>＋ Новый</button></div><select data-select aria-label="Выбрать ровер"></select><div data-status class="rv-stats"></div><p data-access></p></section><section class="rv-vision"><div class="rv-view-tabs"><button data-view="camera">Камера ровера</button><button data-view="map">Карта <kbd>Tab</kbd></button></div><div class="rv-live-view"><canvas data-preview tabindex="0" aria-label="Камера и карта. Tab переключает вид. Нажмите на карту для выбора точки."></canvas><div data-no-signal>Нет сигнала<small>Выберите доступный ровер</small></div><div class="rv-live-hud"><span data-preview-label></span><span data-camera-coords></span></div></div><p data-view-help></p></section><section class="rv-points"><div class="rv-section-title">ТОЧКИ ЭКСПЕДИЦИИ <button data-map-pick>＋ На карте</button></div><p>Клик по карте запишет координаты в текущий файл.</p><div data-points></div><button data-route class="rv-route-button">Создать программу маршрута</button></section></aside>
      </main><div class="rv-bottom"><span>● БЛОКНОТ ЭКСПЕДИЦИИ</span><span data-local-status>Автосохранение включено</span></div>`;
    document.body.append(this.panel);
    try {this.localFiles=JSON.parse(localStorage.getItem(storageKey));} catch {}
    if(!Array.isArray(this.localFiles?.files)||!this.localFiles.files.length||!this.localFiles.files.every(f=>typeof f.id==='string'&&typeof f.code==='string'&&typeof f.name==='string'&&typeof f.folder==='string')) this.localFiles={folders:['Программы'],files:[{id:'main',folder:'Программы',name:'first_mission.txt',code:starter}],selected:'main'};
    this.localFiles.folders=[...new Set([...(Array.isArray(this.localFiles.folders)?this.localFiles.folders:[]),...this.localFiles.files.map(f=>f.folder)])];
    this.localSelected=this.localFiles.files.some(f=>f.id===this.localFiles.selected)?this.localFiles.selected:this.localFiles.files[0].id;
    this.localFolder=this.localFiles.files.find(f=>f.id===this.localSelected).folder;
    const on=(selector,event,fn)=>this.q(selector).addEventListener(event,fn,{signal:this.abort.signal});
    this.button.addEventListener('click',()=>this.open(),{signal:this.abort.signal});
    on('[data-close]','click',()=>this.panel.close());
    this.panel.addEventListener('close',()=>this.resume(),{signal:this.abort.signal});
    this.panel.addEventListener('keydown',e=>{if(e.key==='Tab'&&e.target===this.q('[data-preview]')&&!e.shiftKey){e.preventDefault();this.setView(this.view==='map'?'camera':'map');}e.stopPropagation();},{signal:this.abort.signal});
    on('[data-program]','input',()=>{this.persistLocal();this.paint();this.renderControls();});
    on('[data-program]','scroll',e=>{this.q('[data-lines]').scrollTop=e.target.scrollTop;});
    on('[data-filename]','change',()=>{this.persistLocal();this.renderFiles();});
    on('[data-new-folder]','click',()=>{const name=prompt('Название папки')?.trim();if(!name)return;this.persistLocal();if(!this.localFiles.folders.includes(name))this.localFiles.folders.push(name);this.localFolder=name;this.persistLocal();this.renderFiles();});
    on('[data-new-file]','click',()=>{const name=prompt('Название файла','mission.txt')?.trim();if(!name)return;this.persistLocal();const f={id:crypto.randomUUID(),folder:this.localFolder,name,code:starter};this.localFiles.files.push(f);this.openLocal(f.id);});
    on('[data-tree]','click',e=>{const file=e.target.closest('[data-file-id]'),folder=e.target.closest('[data-folder-name]');if(file)this.openLocal(file.dataset.fileId);else if(folder){this.localFolder=folder.dataset.folderName;this.renderFiles();}});
    on('[data-tabs]','click',e=>{const f=e.target.closest('[data-file-id]');if(f)this.openLocal(f.dataset.fileId);});
    on('[data-select]','change',e=>{this.selected=e.target.value;this.render();});
    on('[data-purchase]','click',()=>this.command('rover.purchase',{}));
    on('[data-stop]','click',()=>this.command('rover.stop',{rover_id:this.selected}));
    on('[data-save]','click',()=>this.sendProgram(false));
    on('[data-run]','click',()=>this.sendProgram(true));
    this.panel.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>this.setView(b.dataset.view),{signal:this.abort.signal}));
    on('[data-route]','click',()=>this.createRoute());
    on('[data-map-pick]','click',()=>{this.setView('map');this.q('[data-preview]').focus();});
    on('[data-preview]','click',e=>{if(this.view!=='map')return;const point=this.scene.pickRoverPreviewPoint?.({clientX:e.clientX,clientY:e.clientY});if(point)this.addPoint(point);else this.feedback('Выберите участок поверхности планеты.');});
    on('[data-preview]','wheel',e=>{if(this.view!=='map')return;e.preventDefault();this.scene.zoomRoverPreview?.(e.deltaY*.001);});
    let drag=null;
    on('[data-preview]','pointerdown',e=>{if(this.view==='map'&&e.button===2){drag={x:e.clientX,y:e.clientY};e.target.setPointerCapture(e.pointerId);}});
    on('[data-preview]','pointermove',e=>{if(!drag)return;this.scene.orbitRoverPreview?.({x:(e.clientX-drag.x)*.006,y:(e.clientY-drag.y)*.006});drag={x:e.clientX,y:e.clientY};});
    on('[data-preview]','pointerup',()=>{drag=null;});on('[data-preview]','pointercancel',()=>{drag=null;});on('[data-preview]','contextmenu',e=>e.preventDefault());
    this.unsubs=[events.on('rover.preview.available',available=>{this.q('[data-no-signal]').hidden=!!available;}),events.on('rover.command.sent',({requestId,type})=>{this.pendingCommands.set(requestId,{type,operation:this.sending});}),events.on('command.result',m=>this.result(m)),events.on('world.state',s=>{this.state=s;this.render();}),events.on('rover.open',()=>this.open()),events.on('connection.status',s=>{if(s!=='connected'){this.state=null;this.busy=false;this.pendingCommands.clear();if(this.panel.open)this.panel.close();this.render();}}),events.on('expedition.lobby',()=>{if(this.panel.open)this.panel.close();})];
    this.openLocal(this.localSelected);
  }
  q(s){return this.panel.querySelector(s);}
  command(type,payload){this.events.emit('command',{type,payload});}
  feedback(text){this.q('[data-feedback]').textContent=text;}
  persistLocal(){const f=this.localFiles.files.find(f=>f.id===this.localSelected);if(f){f.code=this.q('[data-program]').value;f.name=this.q('[data-filename]').value.trim()||'mission.txt';}this.localFiles.selected=this.localSelected;try{localStorage.setItem(storageKey,JSON.stringify(this.localFiles));this.q('[data-local-status]').textContent='Сохранено в браузере';}catch{this.q('[data-local-status]').textContent='Не удалось сохранить — хранилище недоступно';}}
  openLocal(id){if(this.loaded)this.persistLocal();const f=this.localFiles.files.find(f=>f.id===id);if(!f)return;this.localSelected=id;this.localFolder=f.folder;this.q('[data-program]').value=f.code;this.q('[data-filename]').value=f.name;this.loaded=true;this.persistLocal();this.renderFiles();this.paint();this.renderControls();}
  renderFiles(){this.q('[data-tree]').innerHTML=this.localFiles.folders.map(folder=>`<div class="rv-folder"><button class="${folder===this.localFolder?'chosen':''}" data-folder-name="${esc(folder)}">▾ <span>▱ ${esc(folder)}</span></button>${this.localFiles.files.filter(f=>f.folder===folder).map(f=>`<button data-file-id="${esc(f.id)}" class="rv-file ${f.id===this.localSelected?'active':''}" aria-current="${f.id===this.localSelected}">⌁ ${esc(f.name)}</button>`).join('')}</div>`).join('');this.q('[data-tabs]').innerHTML=this.localFiles.files.map(f=>`<button data-file-id="${esc(f.id)}" class="${f.id===this.localSelected?'active':''}" aria-current="${f.id===this.localSelected}">⌁ ${esc(f.name)}</button>`).join('');const f=this.localFiles.files.find(f=>f.id===this.localSelected);this.q('[data-path]').textContent=`Экспедиция / ${f.folder} / ${f.name}`;}
  paint(){this.q('[data-lines]').innerHTML=this.q('[data-program]').value.split('\n').map((_,i)=>`<span>${i+1}</span>`).join('');this.renderPoints();this.updatePreview();}
  renderPoints(){const points=[...this.q('[data-program]').value.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gm)];this.q('[data-points]').innerHTML=points.length?points.map(p=>`<article><b>⌖ ${esc(p[1])}</b><span>${fmt(Number(p[2]))}° / ${fmt(Number(p[3]))}°</span></article>`).join(''):'<div class="rv-empty">Маршрут ещё не задан.<br>Откройте карту и выберите точку.</div>';}
  addPoint({latitude,longitude}){const e=this.q('[data-program]');let i=1;while(new RegExp(`\\bPOINT_${i}\\b`).test(e.value))i++;latitude=Number(latitude.toFixed(4));longitude=Number(longitude.toFixed(4));if(longitude>=180)longitude=-180;if(Math.abs(latitude)===90)longitude=0;const name=`POINT_${i}`;e.value=`${name} = (${fmt(latitude)}, ${fmt(longitude)})\n${e.value}`;this.persistLocal();this.paint();this.renderControls();this.feedback(`${name} записана. Для движения добавьте move_to(${name}).`);}
  createRoute(){
    const declarations=[...this.q('[data-program]').value.matchAll(/^([A-Za-z_][A-Za-z0-9_]{0,23})\s*=\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gm)];
    if(!declarations.length){this.setView('map');this.q('[data-preview]').focus();this.feedback('Сначала выберите хотя бы одну точку на карте.');return;}
    this.persistLocal();
    const points=declarations.reverse();
    const code=points.map(p=>p[0]).join('\n')+'\n\n'+points.map(p=>'move_to('+p[1]+')\nwait(1)').join('\n')+'\n';
    const max=this.state?.config?.rover?.program_max_bytes||512;
    if(new TextEncoder().encode(code).length>max){this.feedback('Маршрут слишком длинный. Уменьшите число точек.');return;}
    const file={id:crypto.randomUUID(),folder:this.localFolder,name:'route_'+this.localFiles.files.length+'.txt',code};
    this.localFiles.files.push(file);this.openLocal(file.id);this.feedback('Программа маршрута готова: ровер посетит точки в порядке выбора. Нажмите «Запустить».');
  }
  setView(view){this.view=view;this.panel.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));this.q('[data-view-help]').textContent=view==='map'?'Клик — точка · колесо — масштаб · правая кнопка — вращение':'Живой вид с камеры выбранного ровера.';this.updatePreview();}
  updatePreview(){if(!this.panel.open)return;this.scene.setRoverPreview?.({canvas:this.q('[data-preview]'),roverId:this.selected,mode:this.view,points:[...this.q('[data-program]').value.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gm)].map(p=>({name:p[1],latitude:Number(p[2]),longitude:Number(p[3])}))});this.q('[data-preview-label]').textContent=this.view==='map'?'КАРТА ЭКСПЕДИЦИИ':'КАМЕРА / LIVE';const p=this.state?.rover_fleet?.find(r=>r.rover_id===this.selected)?.position;this.q('[data-camera-coords]').textContent=p?`${fmt(Math.asin(p[1]/Math.hypot(...p))*180/Math.PI)}° / ${fmt(Math.atan2(p[2],p[0])*180/Math.PI)}°`:'';}
  sendProgram(run){if(this.busy)return;const r=this.state?.rover_fleet?.find(r=>r.rover_id===this.selected);if(!r)return;this.persistLocal();this.busy=true;this.sending={roverId:r.rover_id,run};this.command('rover.program',{rover_id:r.rover_id,program:this.q('[data-program]').value,expected_revision:r.program_revision});this.sending=null;this.feedback('Передача программы…');this.renderControls();}
  result(m){const pending=this.pendingCommands.get(m.request_id);if(!pending)return;this.pendingCommands.delete(m.request_id);const r=m.payload||{};if(pending.type==='rover.program'&&r.ok&&pending.operation?.run){this.command('rover.start',{rover_id:pending.operation.roverId,expected_revision:r.program_revision});return;}this.busy=false;const failures={INVALID_PROGRAM:'Проверьте команды и структуру программы.',PROGRAM_TOO_LONG:'Программа превышает допустимый размер.',UNKNOWN_POINT:'Сначала объявите координаты точки.',REVISION_CONFLICT:'Программа ровера изменилась. Повторите передачу после обновления состояния.',OFFICE_REQUIRED:'Для запуска подойдите к офису.',INSUFFICIENT_RESOURCES:'Недостаточно ресурсов для покупки ровера.'};this.feedback(r.ok?({'rover.program':'Программа передана роверу.','rover.start':'Программа запущена.','rover.stop':'Ровер остановлен.','rover.purchase':'Ровер добавлен.'}[pending.type]||'Готово.'):`${failures[r.code]||`Ошибка: ${r.code||'нет ответа'}`}${r.line?` Строка ${r.line}.`:''}`);this.renderControls();}
  renderControls(){const s=this.state,r=s?.rover_fleet?.find(r=>r.rover_id===this.selected),bytes=new TextEncoder().encode(this.q('[data-program]').value).length,max=s?.config?.rover?.program_max_bytes||512,active=r&&['running','waiting'].includes(r.status);this.q('[data-bytes]').textContent=`${bytes} / ${max} байт`;for(const key of ['save','run'])this.q(`[data-${key}]`).disabled=this.busy||!s?.office_access||!r||active||bytes>max||!this.q('[data-program]').value.trim();this.q('[data-stop]').disabled=!r||!active||this.busy;this.q('[data-purchase]').disabled=!s?.office_access||this.busy;this.q('[data-line]').textContent=r?.error?`Ровер: ${r.error}`:r?.line?`Выполняется строка ${r.line} переданной программы.`:'Программа выполняется последовательно. Запуск автоматически передаёт текущий файл.';}
  render(){const s=this.state;this.button.hidden=!s||s.stage!=='running';if(!s||!this.panel.open)return;const fleet=s.rover_fleet||[];if(!fleet.some(r=>r.rover_id===this.selected))this.selected=fleet[0]?.rover_id||null;const select=this.q('[data-select]');select.replaceChildren(...fleet.map((r,i)=>new Option(`Ровер ${String(i+1).padStart(2,'0')} · ${statuses[r.status]||r.status}`,r.rover_id)));if(!fleet.length)select.add(new Option('Нет доступных роверов',''));select.value=this.selected||'';const r=fleet.find(r=>r.rover_id===this.selected);this.q('[data-status]').innerHTML=r?`<div><small>СОСТОЯНИЕ</small><b>${esc(statuses[r.status]||r.status)}</b></div><div><small>ГРУЗ</small><b>${r.cargo_mass??0} / ${r.capacity??50} кг</b></div><div><small>СКОРОСТЬ</small><b>${fmt(r.speed??0)} м/с</b></div>`:'<p>Добавьте ровер для запуска программ.</p>';this.q('[data-access]').textContent=s.office_access?'Офис доступен · передача и запуск разрешены':'Для передачи и запуска подойдите к офису. Файлы и карта доступны здесь.';this.renderControls();this.setView(this.view);}
  open(){if(!this.state||this.state.stage!=='running'||this.panel.open)return;this.scene.controls.suspended=true;this.scene.controls.clear();if(document.pointerLockElement)document.exitPointerLock();this.events.emit('ui.overlay',true);this.panel.showModal();this.render();}
  resume(){if(this.panel.open)return;this.persistLocal();this.scene.clearRoverPreview?.();const suspended=!!document.querySelector('dialog[open]');this.scene.controls.suspended=suspended;this.scene.controls.clear();this.events.emit('ui.overlay',suspended);}
  dispose(){if(this.panel.open){this.panel.close();this.resume();}this.unsubs.forEach(f=>f());this.abort.abort();this.button.remove();this.panel.remove();}
}

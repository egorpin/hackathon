import "./rover.css";
import { restorePointerLock } from './pointer-lock.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { closeOpenTab, moveLocalFile, normalizeOpenTabs } from './local-files.js';

const fmt = n => Number.isFinite(n) ? n.toFixed(4) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = {idle:'Готов',running:'В пути',waiting:'Ожидает',error:'Ошибка'};
const starter = '# Первая программа: проверка связи\nwait(1)\n';
const fileTransferType = 'application/x-mars-rover-file-id';
const documentation = "# Бортовой блокнот — руководство\n\n## Файлы\nСоздавайте папки и программы слева. Файлы сохраняются автоматически в этом браузере. README.md всегда первый в папке «Программы» и доступен только для чтения.\n\n## Удалённое управление\nПередавать и запускать программы можно из любой точки планеты. Выберите ровер, откройте программу и нажмите «Запустить»: файл будет передан и выполнен. Перед изменением работающей программы нажмите «Стоп». Покупка нового ровера доступна у офиса.\n\n## Карта и камера\nКарта / Tab переключает вид, когда карта в фокусе. Левый клик записывает точку в начало текущей программы. Правая кнопка и движение мыши вращают Марс; колесо меняет масштаб. Текущая позиция ровера выделена отдельным маркером. Кнопка «Создать программу маршрута» создаёт новый файл с последовательным посещением точек.\n\n## Rover Script\nЭто небольшой язык управления ровером, не Python. Лимит программы — 512 байт UTF-8. Комментарии начинаются с # или --. Координаты объявляются до команд; широта от -90 до 90, долгота от -180 до 180 (180 не включается). На полюсах долгота равна 0.\n\nDEST = (12.3456, 24.5678)\nmove_to(DEST)\nwait(1)\n\nmove_to(NAME) — движение к объявленной точке.\nwait(1) — ожидание в секундах.\nload(20) — загрузка до 20 кг у своего бура.\nunload() — разгрузка у своего склада.\n\nwhile true do\n    load(20)\n    unload()\n    wait(1)\nend\n\nЦикл повторяется до остановки. Для реальной доставки добавьте move_to к буру и складу перед load и unload. Ровер не прокладывает обход препятствий: выбирайте промежуточные точки. Об ошибках движения сообщает панель выполнения.\n\n## Окна\nПеретаскивайте разделители между колонками, файлами и чатом, картой и точками. Размеры сохраняются в браузере. Разделитель в фокусе также управляется стрелками.\n";
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
      <header class="rv-head"><h1>Бортовой блокнот</h1><span data-local-status>Автосохранение включено</span><button data-close aria-label="Закрыть блокнот">Закрыть <kbd>Esc</kbd></button></header>
      <main class="rv-workspace">
        <aside class="rv-sidebar"><section class="rv-explorer"><div class="rv-section-title">ФАЙЛЫ <span>ЛОКАЛЬНО</span></div><div class="rv-file-actions"><button data-new-folder>＋ Папка</button><button data-new-file>＋ Файл</button></div><nav data-tree aria-label="Файлы экспедиции"></nav></section><div class="rv-split horizontal" data-resize="files" role="separator" tabindex="0" aria-label="Высота файлов и чата" aria-orientation="horizontal"></div><section class="rv-chat"><div class="rv-section-title">ЧАТ <span>ИИ-ПОМОЩНИК</span></div><div data-chat-log role="log" aria-live="polite"><div class="rv-chat-empty"><b>ИИ-помощник</b><p>Здесь появится диалог с помощником по программам и экспедиции.</p></div></div><p data-chat-status role="status">Чат пока не подключён</p><form data-chat-form><textarea data-chat-input aria-label="Сообщение" placeholder="Сообщение помощнику…" maxlength="1000" rows="2" disabled></textarea><button data-chat-send type="submit" disabled>Отправить</button></form></section></aside><div class="rv-split" data-resize="left" role="separator" tabindex="0" aria-label="Ширина файлов и чата" aria-orientation="vertical"></div>
        <section class="rv-code"><nav class="rv-file-tabs" data-tabs aria-label="Открытые файлы"></nav><div class="rv-toolbar"><label>Имя файла<input data-filename aria-label="Имя файла"></label><div><button data-markdown-toggle hidden>Изменить исходник</button><button data-save>Передать</button><button data-stop>■ Стоп</button><button class="rv-primary" data-run>▶ Запустить</button></div></div><div class="rv-meta"><span data-path></span><span data-feedback role="status" aria-live="polite"></span><span data-bytes></span></div><div class="rv-editor"><div data-lines aria-hidden="true"></div><pre data-highlight aria-hidden="true"></pre><textarea data-program spellcheck="false" aria-label="Программа ровера"></textarea><article class="rv-markdown" data-markdown hidden></article><div class="rv-editor-empty" data-editor-empty hidden>Все вкладки закрыты.<small>Выберите файл слева, чтобы открыть его.</small></div></div></section>
        <div class="rv-split" data-resize="right" role="separator" tabindex="0" aria-label="Ширина карты" aria-orientation="vertical"></div><aside class="rv-mission"><section class="rv-fleet"><div class="rv-section-title">РОВЕР <button data-purchase>＋ Новый</button></div><select data-select aria-label="Выбрать ровер"></select><div data-status class="rv-stats"></div><p data-access></p><p data-line></p></section><section class="rv-vision"><div class="rv-view-tabs"><button data-view="camera">Камера ровера</button><button data-view="map">Карта <kbd>Tab</kbd></button></div><div class="rv-live-view"><canvas data-preview tabindex="0" aria-label="Камера ровера и карта. На карте: левая кнопка мыши — вращать, правая — поставить точку, колесо — масштаб."></canvas><div data-no-signal>Нет сигнала<small>Выберите доступный ровер</small></div><div class="rv-live-hud"><span data-preview-label></span><span data-camera-coords></span></div></div><p data-view-help></p></section><div class="rv-split horizontal" data-resize="vision" role="separator" tabindex="0" aria-label="Высота карты" aria-orientation="horizontal"></div><section class="rv-points"><div class="rv-section-title">ТОЧКИ ЭКСПЕДИЦИИ <button data-map-pick>＋ На карте</button></div><p>ПКМ по карте запишет координаты в текущий файл.</p><div data-points></div><button data-route class="rv-route-button">Создать программу маршрута</button></section></aside>
      </main>`;
    document.body.append(this.panel);
    try {this.localFiles=JSON.parse(localStorage.getItem(storageKey));} catch {}
    if(!Array.isArray(this.localFiles?.files)||!this.localFiles.files.length||!this.localFiles.files.every(f=>typeof f.id==='string'&&typeof f.code==='string'&&typeof f.name==='string'&&typeof f.folder==='string')) this.localFiles={folders:['Программы'],files:[{id:'main',folder:'Программы',name:'first_mission.txt',code:starter}],selected:'main'};
    const storedOpenTabs=Array.isArray(this.localFiles.openTabs)?this.localFiles.openTabs:null;
    this.localFiles.folders=[...new Set([...(Array.isArray(this.localFiles.folders)?this.localFiles.folders:[]),...this.localFiles.files.map(f=>f.folder)])];
    this.localFiles.files=this.localFiles.files.filter(f=>f.id!=='notebook-readme');
    this.localFiles.files.unshift({id:'notebook-readme',folder:'Программы',name:'README.md',code:documentation,readOnly:true});
    this.localFiles.folders=['Программы',...this.localFiles.folders.filter(f=>f!=='Программы')];
    this.openTabs=normalizeOpenTabs(this.localFiles.files,storedOpenTabs);
    this.localSelected=this.openTabs.includes(this.localFiles.selected)?this.localFiles.selected:(this.openTabs[0]||null);
    this.localFolder=this.localFiles.files.find(f=>f.id===this.localSelected)?.folder||'Программы';
    const on=(selector,event,fn)=>this.q(selector).addEventListener(event,fn,{signal:this.abort.signal});
    this.button.addEventListener('click',()=>this.open(),{signal:this.abort.signal});
    on('[data-close]','click',()=>{this.panel.close();this.resume();});
    this.panel.addEventListener('cancel',event=>{event.preventDefault();this.panel.close();this.resume();},{signal:this.abort.signal});
    this.panel.addEventListener('close',()=>this.resume(),{signal:this.abort.signal});
    this.panel.addEventListener('keydown',e=>{if(e.key==='Tab'&&e.target===this.q('[data-preview]')&&!e.shiftKey){e.preventDefault();this.setView(this.view==='map'?'camera':'map');}e.stopPropagation();},{signal:this.abort.signal});
    on('[data-program]','input',()=>{this.persistLocal();this.paint();this.renderControls();});
    on('[data-program]','scroll',e=>{this.syncEditorScroll();});
    on('[data-markdown-toggle]','click',()=>{this.markdownEditing=!this.markdownEditing;this.paint();});
    on('[data-filename]','change',()=>{this.persistLocal();this.renderFiles();this.paint();this.renderControls();});
    on('[data-new-folder]','click',()=>{const name=prompt('Название папки')?.trim();if(!name)return;this.persistLocal();if(!this.localFiles.folders.includes(name))this.localFiles.folders.push(name);this.localFolder=name;this.persistLocal();this.renderFiles();});
    on('[data-new-file]','click',()=>{const name=prompt('Название файла','mission.txt')?.trim();if(!name)return;this.persistLocal();const f={id:crypto.randomUUID(),folder:this.localFolder,name,code:starter};this.localFiles.files.push(f);this.openLocal(f.id);});
    on('[data-tree]','click',e=>{const file=e.target.closest('[data-file-id]'),folder=e.target.closest('[data-folder-name]');if(file)this.openLocal(file.dataset.fileId);else if(folder){this.localFolder=folder.dataset.folderName;this.renderFiles();}});
    on('[data-tabs]','click',e=>{const close=e.target.closest('[data-close-tab]');if(close){this.closeTab(close.dataset.closeTab);return;}const f=e.target.closest('[data-file-id]');if(f)this.openLocal(f.dataset.fileId);});
    const startFileDrag=e=>{const button=e.target.closest('[data-file-id]');if(!button||!e.dataTransfer)return;const file=this.localFiles.files.find(item=>item.id===button.dataset.fileId);if(!file||file.readOnly){e.preventDefault();return;}e.dataTransfer.setData(fileTransferType,file.id);e.dataTransfer.effectAllowed='move';};
    const clearFolderTargets=()=>this.q('[data-tree]').querySelectorAll('.drop-target').forEach(folder=>folder.classList.remove('drop-target'));
    const dragOverFolder=e=>{const folder=e.target.closest('[data-folder-name]');if(!folder||!Array.from(e.dataTransfer?.types||[]).includes(fileTransferType))return;e.preventDefault();e.dataTransfer.dropEffect='move';folder.classList.add('drop-target');};
    const leaveFolder=e=>{const folder=e.target.closest('[data-folder-name]');if(folder&&!folder.contains(e.relatedTarget))folder.classList.remove('drop-target');};
    const dropFile=e=>{const folder=e.target.closest('[data-folder-name]');if(!folder||!Array.from(e.dataTransfer?.types||[]).includes(fileTransferType))return;e.preventDefault();const id=e.dataTransfer.getData(fileTransferType),folderName=folder.dataset.folderName;clearFolderTargets();if(!moveLocalFile(this.localFiles.files,this.localFiles.folders,id,folderName))return;if(this.localSelected===id)this.localFolder=folderName;this.persistLocal();this.renderFiles();};
    for(const selector of ['[data-tree]','[data-tabs]']){on(selector,'dragstart',startFileDrag);on(selector,'dragend',clearFolderTargets);}
    on('[data-tree]','dragover',dragOverFolder);on('[data-tree]','dragleave',leaveFolder);on('[data-tree]','drop',dropFile);
    on('[data-select]','change',e=>{this.selected=e.target.value;this.render();});
    on('[data-purchase]','click',()=>this.command('rover.purchase',{}));
    on('[data-stop]','click',()=>this.command('rover.stop',{rover_id:this.selected}));
    on('[data-save]','click',()=>this.sendProgram(false));
    on('[data-run]','click',()=>this.sendProgram(true));
    this.panel.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>this.setView(b.dataset.view),{signal:this.abort.signal}));
    on('[data-route]','click',()=>this.createRoute());
    on('[data-map-pick]','click',()=>{this.setView('map');this.q('[data-preview]').focus();});
    on('[data-preview]','wheel',e=>{if(this.view!=='map')return;e.preventDefault();this.scene.zoomRoverPreview?.(e.deltaY*.001);});
    let drag=null;
    on('[data-preview]','pointerdown',e=>{if(this.view==='map'&&e.button===0){drag={x:e.clientX,y:e.clientY};e.target.setPointerCapture(e.pointerId);}});
    on('[data-preview]','pointermove',e=>{if(!drag)return;this.scene.orbitRoverPreview?.({x:(e.clientX-drag.x)*.006,y:(e.clientY-drag.y)*.006});drag={x:e.clientX,y:e.clientY};});
    on('[data-preview]','pointerup',()=>{drag=null;});on('[data-preview]','pointercancel',()=>{drag=null;});
    on('[data-preview]','contextmenu',e=>{if(this.view!=='map')return;e.preventDefault();const point=this.scene.pickRoverPreviewPoint?.({clientX:e.clientX,clientY:e.clientY});if(point)this.addPoint(point);else this.feedback('Выберите участок поверхности планеты.');});
    this.unsubs=[events.on('rover.preview.available',available=>{this.q('[data-no-signal]').hidden=!!available;}),events.on('rover.command.sent',({requestId,type})=>{this.pendingCommands.set(requestId,{type,operation:this.sending});}),events.on('command.result',m=>this.result(m)),events.on('world.state',s=>{this.state=s;this.render();}),events.on('rover.open',()=>this.open()),events.on('connection.status',s=>{if(s!=='connected'){this.state=null;this.busy=false;this.pendingCommands.clear();if(this.panel.open)this.panel.close();this.render();}}),events.on('expedition.lobby',()=>{if(this.panel.open)this.panel.close();})];
    this.setupResize();
    if(this.localSelected)this.openLocal(this.localSelected);
    else {this.renderFiles();this.paint();this.renderControls();}
  }
  highlight(){
    const code=this.q('[data-program]').value;
    this.q('[data-highlight]').innerHTML=code.split('\n').map(line=>{
      if(this.q('[data-program]').readOnly)return esc(line);
      return line.split(/(#.*$|--.*$|\b(?:while|true|do|end|move_to|load|unload|wait)\b|-?\b\d+(?:\.\d+)?\b|\b[A-Z_][A-Z_0-9]*\b)/g).map(token=>{
        const kind=/^(#|--)/.test(token)?'comment':/^(while|true|do|end)$/.test(token)?'keyword':/^(move_to|load|unload|wait)$/.test(token)?'function':/^-?\d/.test(token)?'number':/^[A-Z_][A-Z_0-9]*$/.test(token)?'constant':null;
        return kind?'<span class="rv-token-'+kind+'">'+esc(token)+'</span>':esc(token);
      }).join('');
    }).join('\n')+'\n';this.syncEditorScroll();
  }
  syncEditorScroll(){const e=this.q('[data-program]'),h=this.q('[data-highlight]');h.scrollTop=e.scrollTop;h.scrollLeft=e.scrollLeft;this.q('[data-lines]').scrollTop=e.scrollTop;}
  setupResize(){
    const defaults={left:250,right:350,files:380,vision:300};
    try{this.layout={...defaults,...JSON.parse(localStorage.getItem('mars.rover.layout.v1'))};}catch{this.layout=defaults;}
    delete this.layout.console;
    for(const [key,value] of Object.entries(defaults)){if(!Number.isFinite(this.layout[key]))this.layout[key]=value;this.panel.style.setProperty('--rv-'+key,this.layout[key]+'px');}
    const resize=(key,delta)=>{
      const width=this.q('.rv-workspace').clientWidth,height=this.q('.rv-workspace').clientHeight;
      const limits={left:[180,Math.max(180,width-this.layout.right-372)],right:[260,Math.max(260,width-this.layout.left-372)],files:[120,Math.max(120,height-210)],vision:[160,Math.max(160,height-260)]};
      this.layout[key]=Math.round(Math.max(limits[key][0],Math.min(limits[key][1],this.layout[key]+delta)));
      this.panel.style.setProperty('--rv-'+key,this.layout[key]+'px');
    };
    const save=()=>{try{localStorage.setItem('mars.rover.layout.v1',JSON.stringify(this.layout));}catch{}};
    this.panel.querySelectorAll('[data-resize]').forEach(handle=>{
      const key=handle.dataset.resize,horizontal=handle.classList.contains('horizontal');let start=null;
      handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();start=horizontal?e.clientY:e.clientX;handle.setPointerCapture(e.pointerId);this.panel.classList.add('rv-resizing');},{signal:this.abort.signal});
      handle.addEventListener('pointermove',e=>{if(start===null)return;const current=horizontal?e.clientY:e.clientX;resize(key,(current-start)*(key==='right'?-1:1));start=current;},{signal:this.abort.signal});
      const end=()=>{if(start===null)return;start=null;this.panel.classList.remove('rv-resizing');save();};
      handle.addEventListener('pointerup',end,{signal:this.abort.signal});handle.addEventListener('pointercancel',end,{signal:this.abort.signal});
      handle.addEventListener('keydown',e=>{const directions=horizontal?{ArrowUp:-20,ArrowDown:20}:{ArrowLeft:-20,ArrowRight:20};if(!(e.key in directions))return;e.preventDefault();resize(key,directions[e.key]*(key==='right'?-1:1));save();},{signal:this.abort.signal});
    });
  }
  q(s){return this.panel.querySelector(s);}
  command(type,payload){this.events.emit('command',{type,payload});}
  feedback(text){this.q('[data-feedback]').textContent=text;}
  persistLocal(){const f=this.localFiles.files.find(f=>f.id===this.localSelected);if(f&&!f.readOnly){f.code=this.q('[data-program]').value;f.name=this.q('[data-filename]').value.trim()||'mission.txt';}this.localFiles.openTabs=[...this.openTabs];this.localFiles.selected=this.localSelected;try{localStorage.setItem(storageKey,JSON.stringify(this.localFiles));this.q('[data-local-status]').textContent='Сохранено в браузере';}catch{this.q('[data-local-status]').textContent='Не удалось сохранить — хранилище недоступно';}}
  openLocal(id){if(this.loaded)this.persistLocal();const f=this.localFiles.files.find(f=>f.id===id);if(!f)return;if(!this.openTabs.includes(id))this.openTabs.push(id);this.localSelected=id;this.localFolder=f.folder;this.markdownEditing=false;this.q('[data-program]').value=f.code;this.q('[data-filename]').value=f.name;this.q('[data-filename]').readOnly=!!f.readOnly;this.q('[data-program]').readOnly=!!f.readOnly;this.panel.classList.toggle('rv-reading',!!f.readOnly);this.loaded=true;this.persistLocal();this.renderFiles();this.paint();this.renderControls();}
  closeTab(id){if(!this.openTabs.includes(id))return;this.persistLocal();const wasSelected=this.localSelected===id,{openTabs,selected}=closeOpenTab(this.openTabs,id);this.openTabs=openTabs;if(!wasSelected){this.persistLocal();this.renderFiles();return;}this.localSelected=null;this.loaded=false;if(selected){this.openLocal(selected);return;}this.localFolder='Программы';this.markdownEditing=false;this.panel.classList.remove('rv-reading');this.q('[data-filename]').value='';this.q('[data-filename]').readOnly=false;this.q('[data-program]').value='';this.q('[data-program]').readOnly=false;this.persistLocal();this.renderFiles();this.paint();this.renderControls();}
  renderFiles(){this.q('[data-tree]').innerHTML=this.localFiles.folders.map(folder=>`<div class="rv-folder"><button class="${folder===this.localFolder?'chosen':''}" data-folder-name="${esc(folder)}">▾ <span>▱ ${esc(folder)}</span></button>${this.localFiles.files.filter(f=>f.folder===folder).map(f=>`<button data-file-id="${esc(f.id)}" draggable="${f.readOnly?'false':'true'}" class="rv-file ${f.id===this.localSelected?'active':''}" aria-current="${f.id===this.localSelected}">⌁ ${esc(f.name)}</button>`).join('')}</div>`).join('');this.q('[data-tabs]').innerHTML=this.openTabs.map(id=>this.localFiles.files.find(f=>f.id===id)).filter(Boolean).map(f=>`<div class="rv-file-tab"><button data-file-id="${esc(f.id)}" draggable="${f.readOnly?'false':'true'}" class="${f.id===this.localSelected?'active':''}" aria-current="${f.id===this.localSelected}">⌁ ${esc(f.name)}</button><button type="button" data-close-tab="${esc(f.id)}" aria-label="Закрыть вкладку ${esc(f.name)}">×</button></div>`).join('')||'<span class="rv-tabs-empty">Нет открытых файлов</span>';const f=this.localFiles.files.find(f=>f.id===this.localSelected);this.q('[data-path]').textContent=f?`Экспедиция / ${f.folder} / ${f.name}`:'Все файлы закрыты';}
  paint(){const editor=this.q('[data-program]'),markdown=this.q('[data-markdown]'),empty=this.q('[data-editor-empty]');
    if(!this.localSelected){this.q('[data-lines]').hidden=true;this.q('[data-highlight]').hidden=true;editor.hidden=true;markdown.hidden=true;empty.hidden=false;this.q('[data-markdown-toggle]').hidden=true;this.renderPoints();this.updatePreview();return;}
    empty.hidden=true;const isMarkdown=/\.md$/i.test(this.q('[data-filename]').value),preview=isMarkdown&&!this.markdownEditing;
    this.q('[data-lines]').hidden=preview;this.q('[data-highlight]').hidden=preview;editor.hidden=preview;markdown.hidden=!preview;
    this.q('[data-markdown-toggle]').hidden=!isMarkdown||editor.readOnly;
    this.q('[data-markdown-toggle]').textContent=this.markdownEditing?'Просмотр':'Изменить исходник';
    if(preview){markdown.innerHTML=DOMPurify.sanitize(marked.parse(editor.value,{gfm:true,breaks:false}),{ALLOWED_TAGS:['p','br','strong','em','del','a','ul','ol','li','blockquote','pre','code','h1','h2','h3','h4','h5','h6','hr','table','thead','tbody','tr','th','td'],ALLOWED_ATTR:['href','title','class','start']});for(const link of markdown.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}}
    else {this.q('[data-lines]').innerHTML=editor.value.split('\n').map((_,i)=>`<span>${i+1}</span>`).join('');this.highlight();}
    this.renderPoints();this.updatePreview();}
  renderPoints(){const points=[...this.q('[data-program]').value.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gm)];this.q('[data-points]').innerHTML=points.length?points.map(p=>`<article><b>⌖ ${esc(p[1])}</b><span>${fmt(Number(p[2]))}° / ${fmt(Number(p[3]))}°</span></article>`).join(''):'<div class="rv-empty">Маршрут ещё не задан.<br>Откройте карту и выберите точку.</div>';}
  addPoint({latitude,longitude}){if(!this.localSelected||this.q('[data-program]').readOnly){this.feedback('Создайте или откройте программу для записи точки.');return;}const e=this.q('[data-program]');let i=1;while(new RegExp(`\\bPOINT_${i}\\b`).test(e.value))i++;latitude=Number(latitude.toFixed(4));longitude=Number(longitude.toFixed(4));if(longitude>=180)longitude=-180;if(Math.abs(latitude)===90)longitude=0;const name=`POINT_${i}`;e.value=`${name} = (${fmt(latitude)}, ${fmt(longitude)})\n${e.value}`;this.persistLocal();this.paint();this.renderControls();this.feedback(`${name} записана. Для движения добавьте move_to(${name}).`);}
  createRoute(){
    if(!this.localSelected){this.feedback('Откройте или создайте файл, чтобы записать маршрут.');return;}
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
  setView(view){this.view=view;this.panel.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));this.q('[data-view-help]').textContent=view==='map'?'ЛКМ — вращать · ПКМ — поставить точку · Колесо — масштаб':'Живой вид с камеры выбранного ровера.';this.updatePreview();}
  updatePreview(){if(!this.panel.open)return;this.scene.setRoverPreview?.({canvas:this.q('[data-preview]'),roverId:this.selected,mode:this.view,points:[...this.q('[data-program]').value.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gm)].map(p=>({name:p[1],latitude:Number(p[2]),longitude:Number(p[3])}))});this.q('[data-preview-label]').textContent=this.view==='map'?'КАРТА ЭКСПЕДИЦИИ':'КАМЕРА / LIVE';const p=this.state?.rover_fleet?.find(r=>r.rover_id===this.selected)?.position;this.q('[data-camera-coords]').textContent=p?`${fmt(Math.asin(p[1]/Math.hypot(...p))*180/Math.PI)}° / ${fmt(Math.atan2(p[2],p[0])*180/Math.PI)}°`:'';}
  sendProgram(run){if(this.busy||!this.localSelected||this.q('[data-program]').readOnly)return;const r=this.state?.rover_fleet?.find(r=>r.rover_id===this.selected);if(!r)return;this.persistLocal();this.busy=true;this.sending={roverId:r.rover_id,run};this.command('rover.program',{rover_id:r.rover_id,program:this.q('[data-program]').value,expected_revision:r.program_revision});this.sending=null;this.feedback('Передача программы…');this.renderControls();}
  result(m){const pending=this.pendingCommands.get(m.request_id);if(!pending)return;this.pendingCommands.delete(m.request_id);const r=m.payload||{};if(pending.type==='rover.program'&&r.ok&&pending.operation?.run){this.command('rover.start',{rover_id:pending.operation.roverId,expected_revision:r.program_revision});return;}this.busy=false;const failures={INVALID_PROGRAM:'Проверьте команды и структуру программы.',PROGRAM_TOO_LONG:'Программа превышает допустимый размер.',UNKNOWN_POINT:'Сначала объявите координаты точки.',REVISION_CONFLICT:'Программа ровера изменилась. Повторите передачу после обновления состояния.',OFFICE_REQUIRED:'Для этой операции подойдите к офису.',INSUFFICIENT_RESOURCES:'Недостаточно ресурсов для покупки ровера.'};this.feedback(r.ok?({'rover.program':'Программа передана роверу.','rover.start':'Программа запущена.','rover.stop':'Ровер остановлен.','rover.purchase':'Ровер добавлен.'}[pending.type]||'Готово.'):`${failures[r.code]||`Ошибка: ${r.code||'нет ответа'}`}${r.line?` Строка ${r.line}.`:''}`);this.renderControls();}
  renderControls(){const s=this.state,r=s?.rover_fleet?.find(r=>r.rover_id===this.selected),bytes=new TextEncoder().encode(this.q('[data-program]').value).length,max=s?.config?.rover?.program_max_bytes||512,active=r&&['running','waiting'].includes(r.status);this.q('[data-bytes]').textContent=this.localSelected?`${bytes} / ${max} байт`:'';for(const key of ['save','run'])this.q(`[data-${key}]`).disabled=this.busy||!this.localSelected||this.q('[data-program]').readOnly||!r||active||bytes>max||!this.q('[data-program]').value.trim();this.q('[data-stop]').disabled=!r||!active||this.busy;this.q('[data-purchase]').disabled=!s?.office_access||this.busy;this.q('[data-line]').textContent=r?.error?`Ровер: ${r.error}`:r?.line?`Выполняется строка ${r.line} переданной программы.`:'';}
  render(){const s=this.state;this.button.hidden=!s||s.stage!=='running';if(!s||!this.panel.open)return;const fleet=s.rover_fleet||[];if(!fleet.some(r=>r.rover_id===this.selected))this.selected=fleet[0]?.rover_id||null;const select=this.q('[data-select]');select.replaceChildren(...fleet.map((r,i)=>new Option(`Ровер ${String(i+1).padStart(2,'0')} · ${statuses[r.status]||r.status}`,r.rover_id)));if(!fleet.length)select.add(new Option('Нет доступных роверов',''));select.value=this.selected||'';const r=fleet.find(r=>r.rover_id===this.selected);this.q('[data-status]').innerHTML=r?`<div><small>СОСТОЯНИЕ</small><b>${esc(statuses[r.status]||r.status)}</b></div><div><small>ГРУЗ</small><b>${r.cargo_mass??0} / ${r.capacity??50} кг</b></div><div><small>СКОРОСТЬ</small><b>${fmt(r.speed??0)} м/с</b></div>`:'<p>Добавьте ровер для запуска программ.</p>';this.q('[data-access]').textContent='Удалённое управление · передача и запуск доступны везде';this.renderControls();this.setView(this.view);}
  open(){if(!this.state||this.state.stage!=='running'||this.panel.open)return;this.scene.controls.suspended=true;this.scene.controls.clear();if(document.pointerLockElement)document.exitPointerLock();this.events.emit('ui.overlay',true);this.panel.showModal();this.render();}
  resume(){if(this.panel.open)return;this.persistLocal();this.scene.clearRoverPreview?.();const suspended=!!document.querySelector('dialog[open]');this.scene.controls.suspended=suspended;this.scene.controls.clear();this.events.emit('ui.overlay',suspended);if(!suspended&&!this.disposing&&this.state?.stage==='running')restorePointerLock(this.scene);}
  dispose(){this.disposing=true;if(this.panel.open){this.panel.close();this.resume();}this.unsubs.forEach(f=>f());this.abort.abort();this.button.remove();this.panel.remove();}
}

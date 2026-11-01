import './assistant.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { agentMascot } from './agent-mascot.js';

export class Assistant {
  constructor({scene, events}) {
    this.scene=scene;this.events=events;this.controller=new AbortController();
    scene.controls.canvas.tabIndex=-1;
    this.button=document.createElement('button');this.button.id='assistant-toggle';
    this.button.innerHTML=`<span class="assistant-button-label">ИИ-помощник</span><span class="assistant-button-activity" hidden aria-hidden="true">${agentMascot}<span class="activity-label"></span></span>`;
    this.button.setAttribute('aria-label','ИИ-помощник');this.button.setAttribute('aria-expanded','false');
    this.button.setAttribute('aria-controls','assistant-panel');
    document.querySelector('.header-actions').insertBefore(this.button,document.getElementById('settings-toggle'));
    this.dialog=document.createElement('aside');this.dialog.className='assistant';
    this.dialog.id='assistant-panel';this.dialog.hidden=true;
    this.dialog.setAttribute('aria-labelledby','assistant-title');
    this.dialog.innerHTML=`<div class="assistant-heading"><h2 id="assistant-title">ИИ-помощник</h2><button type="button" class="assistant-close" aria-label="Закрыть ИИ-помощника">✕</button></div>
      <div class="assistant-activity" role="status" aria-live="polite" hidden>${agentMascot}<div><strong>Марсик</strong><span class="activity-label"></span></div><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
      <div class="assistant-messages" role="log" aria-label="Диалог с ИИ" aria-live="polite"></div>
      <p class="assistant-status" role="status"></p>
      <form><label for="assistant-question">Enter — написать / отправить · Shift+Enter — новая строка</label><textarea id="assistant-question" aria-label="Твой вопрос" maxlength="1000" rows="3" placeholder="Как начать освоение Марса?" required></textarea><button type="submit">Отправить</button></form>`;
    document.querySelector('main').append(this.dialog);
    this.log=this.dialog.querySelector('.assistant-messages');this.status=this.dialog.querySelector('.assistant-status');
    this.activity=this.dialog.querySelector('.assistant-activity');
    this.miniActivity=this.button.querySelector('.assistant-button-activity');
    this.form=this.dialog.querySelector('form');this.input=this.dialog.querySelector('textarea');this.send=this.form.querySelector('button');
    window.speechSynthesis?.getVoices();
    const on=(target,name,fn)=>target.addEventListener(name,fn,{signal:this.controller.signal});
    on(this.button,'click',()=>{if(this.dialog.hidden)this.open();else this.close();this.button.blur();});
    on(this.dialog.querySelector('.assistant-close'),'click',()=>this.close());
    on(this.input,'focus',()=>this.beginTyping());
    on(this.input,'blur',()=>this.finishTyping());
    on(window,'keydown',event=>{
      if(event.isComposing || event.repeat)return;
      if(event.key==='Escape' && !this.dialog.hidden && !document.querySelector('dialog[open]')) {
        event.preventDefault();if(this.typing)this.finishTyping(true);else this.close();return;
      }
      if(event.key!=='Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)return;
      if(event.target===this.input) {
        event.preventDefault();if(this.input.value.trim()&&!this.send.disabled)this.ask();else this.finishTyping(true);
      } else if(!event.target?.closest?.('input,textarea,select,button,[contenteditable=true]') && !scene.controls.suspended && !document.querySelector('dialog[open],#auth:not([hidden])')) {
        event.preventDefault();this.open();if(!this.input.disabled)this.input.focus();
      }
    });
    on(this.form,'submit',event=>{event.preventDefault();this.ask();});
  }
  updateActivity() {
    const state=this.speech?.started?'speaking':this.requestPhase||'idle';
    if(this.activity.dataset.state===state)return;
    const label={thinking:'Думает…',writing:'Пишет…',speaking:'Говорит…',idle:''}[state];
    for(const element of [this.activity,this.miniActivity]){
      element.dataset.state=state;element.hidden=state==='idle';
      element.querySelector('.activity-label').textContent=label;
    }
    this.button.querySelector('.assistant-button-label').hidden=state!=='idle';
    this.button.title=label?`Марсик · ${label}`:'ИИ-помощник';
  }
  async revealReply(item) {
    // The endpoint returns a complete answer; "writing" is its on-screen reveal.
    if(document.documentElement.classList.contains('game-reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const animation=this.replyAnimation=item.animate([
      {clipPath:'inset(0 0 100% 0)',opacity:.4},
      {clipPath:'inset(0 0 0% 0)',opacity:1},
    ],{duration:650,easing:'ease-out'});
    try{await animation.finished;}catch{/* Closing the application cancels the reveal. */}
    if(this.replyAnimation===animation)this.replyAnimation=null;
  }
  async json(path,options={}) {
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:this.controller.signal,...options});
    const data=await response.json();
    if(!response.ok)throw Error(response.status===401?'Сначала войди в игру.':typeof data.detail==='string'?data.detail:'Не удалось отправить вопрос.');
    return data;
  }
  message(role,text) {
    const item=document.createElement('div');item.className='assistant-message '+(role==='user'?'user':'reply');
    const label=document.createElement('strong');label.textContent=role==='user'?'Ты':'ИИ-помощник';
    const body=document.createElement('div');body.className='assistant-markdown';
    if(role==='user')body.textContent=text;
    else {
      body.innerHTML=DOMPurify.sanitize(marked.parse(text,{breaks:true}),{
        ALLOWED_TAGS:['p','br','strong','em','del','a','ul','ol','li','blockquote','pre','code','h1','h2','h3','h4','h5','h6','hr','table','thead','tbody','tr','th','td'],
        ALLOWED_ATTR:['href','title','class','start'],
      });
      for(const link of body.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}
    }
    item.append(label,body);this.log.append(item);this.log.scrollTop=this.log.scrollHeight;
    if(role!=='user') {
      const actions=document.createElement('div');actions.className='assistant-speech';
      const speak=document.createElement('button');speak.type='button';speak.textContent='Озвучить';
      const stop=document.createElement('button');stop.type='button';stop.textContent='Стоп';stop.disabled=true;
      const status=document.createElement('span');status.setAttribute('role','status');
      if(!window.speechSynthesis || !window.SpeechSynthesisUtterance){speak.disabled=true;speak.title='Браузер не поддерживает озвучку.';}
      speak.addEventListener('click',()=>this.speak(body,{speak,stop,status}),{signal:this.controller.signal});
      stop.addEventListener('click',()=>this.stopSpeech(),{signal:this.controller.signal});
      actions.append(speak,stop,status);item.append(actions);this.log.scrollTop=this.log.scrollHeight;
    }
    return item;
  }
  speak(body,controls) {
    this.stopSpeech();
    const text=body.innerText.trim();if(!text)return;
    const synth=window.speechSynthesis;
    const russian=synth.getVoices().filter(voice=>/^ru(?:-|_)/i.test(voice.lang));
    if(!russian.length) {
      controls.status.textContent='Русский голос недоступен. Добавьте его в настройках речи системы.';return;
    }
    const voice=russian.find(voice=>voice.localService)||russian[0];
    const chunks=text.match(/[^.!?\n]{1,180}(?:[.!?]+|\n|\s|$)|\S{1,180}/g)||[text];
    const active=this.speech={...controls};
    controls.speak.disabled=true;controls.stop.disabled=false;controls.status.textContent='Озвучивание…';
    const next=()=>{
      if(this.speech!==active)return;
      const chunk=chunks.shift();if(!chunk){this.stopSpeech();return;}
      const utterance=new window.SpeechSynthesisUtterance(chunk);utterance.lang='ru-RU';utterance.voice=voice;
      active.utterance=utterance;
      utterance.onstart=()=>{if(this.speech===active){active.started=true;this.updateActivity();}};
      utterance.onend=next;
      utterance.onerror=()=>{if(this.speech===active){this.stopSpeech();controls.status.textContent='Не удалось озвучить ответ.';}};
      try{synth.speak(utterance);}catch{this.stopSpeech();controls.status.textContent='Не удалось озвучить ответ.';}
    };
    next();
  }
  stopSpeech() {
    const active=this.speech;if(!active)return;
    this.speech=null;
    window.speechSynthesis.cancel();
    active.speak.disabled=false;active.stop.disabled=true;active.status.textContent='';
    this.updateActivity();
  }
  async open() {
    if(!this.dialog.hidden)return;
    this.dialog.hidden=false;this.button.setAttribute('aria-expanded','true');
    if(this.busy)return;
    this.send.disabled=true;this.status.textContent='Загружаем диалог…';
    try {
      const data=await this.json('/api/agent/messages');this.stopSpeech();this.log.replaceChildren();
      for(const item of data.messages)this.message(item.role,item.text);
      this.status.textContent=data.messages.length?'':'Задай первый вопрос помощнику.';
      this.send.disabled=false;
    }catch(error){this.status.textContent=error.message;}
  }
  beginTyping() {
    if(this.typing)return;
    this.typing=true;this.wasSuspended=!!this.scene.controls.suspended;
    this.wasLocked=document.pointerLockElement===this.scene.controls.canvas;
    this.scene.controls.suspended=true;this.scene.controls.clear();
    if(document.pointerLockElement)document.exitPointerLock();
    this.events.emit('ui.overlay',true);
  }
  finishTyping(restorePointer=false) {
    if(!this.typing)return;
    this.typing=false;
    const suspended=this.wasSuspended || !!document.querySelector('dialog[open]');
    this.scene.controls.suspended=suspended;this.scene.controls.clear();
    this.events.emit('ui.overlay',suspended);
    this.input.blur();
    if(restorePointer && !suspended) {
      const canvas=this.scene.controls.canvas;canvas.tabIndex=-1;canvas.focus({preventScroll:true});
      if(this.wasLocked && this.scene.controls.mode==='first')canvas.requestPointerLock()?.catch(()=>{});
    }
  }
  close() {this.stopSpeech();this.finishTyping(true);this.dialog.hidden=true;this.button.setAttribute('aria-expanded','false');this.button.blur();}
  async ask() {
    const text=this.input.value.trim();if(!text||this.busy)return;
    this.finishTyping(true);
    this.stopSpeech();
    this.busy=true;this.send.disabled=true;this.input.disabled=true;
    this.requestPhase='thinking';this.updateActivity();
    this.message('user',text);this.input.value='';this.status.textContent='';
    try {
      const answer=await this.json('/api/agent/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
      if(this.controller.signal.aborted)return;
      this.requestPhase='writing';this.updateActivity();
      await this.revealReply(this.message('assistant',answer.text));this.status.textContent='';
    }catch(error){if(!this.controller.signal.aborted){this.status.textContent=error.message;this.input.value=text;}}
    finally{this.requestPhase=null;this.updateActivity();this.busy=false;this.send.disabled=false;this.input.disabled=false;}
  }
  dispose(){this.stopSpeech();this.finishTyping();this.controller.abort();this.replyAnimation?.cancel();this.dialog.remove();this.button.remove();}
}

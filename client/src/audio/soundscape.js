import { makeSamples } from './sound-buffers.js';
const ACTION_SOUNDS=Object.freeze({'building.place':'construct','building.remove':'deconstruct','resource.pickup':'pickup','resource.deposit':'deposit','resource.give':'deposit','rover.purchase':'rover','rover.start':'rover','rover.stop':'rover-stop','rover.survey':'scan','rover.point.register':'confirm','rover.program':'confirm','player.respawn':'respawn','player.teleport':'teleport','landing.select':'confirm'});
export function actionSound(result){return !result?.payload?.ok?'error':ACTION_SOUNDS[result.command?.type]||null;}
export function sceneSoundLevels(state={}){const levels=new Map();for(const building of state.buildings||[])if(building.active&&building.type)levels.set(building.type,Math.max(levels.get(building.type)||0,building.gain||0));if(state.rover)levels.set('rover',Math.max(levels.get('rover')||0,state.rover));return levels;}
const clamp=(value,min=0,max=1)=>Math.min(max,Math.max(min,value));
export class Soundscape{
constructor({events,target=document}={}){this.events=events;this.context=null;this.master=null;this.unlocked=false;this.lastStep=0;this.lastJump=0;this.loops=new Map();this.abort=new AbortController();const unlock=()=>this.unlock();target?.addEventListener('pointerdown',unlock,{capture:true,passive:true,signal:this.abort.signal});target?.addEventListener('keydown',unlock,{capture:true,signal:this.abort.signal});this.unsubs=[events?.on('audio.motion',motion=>this.motion(motion)),events?.on('command.result',result=>this.play(actionSound(result))),events?.on('world.stage',stage=>{if(stage==='running'&&this.stage!=='running')this.play('start');this.stage=stage;if(stage!=='running')this.updateScene({});}),events?.on('camera.changed',()=>this.play('camera')),events?.on('build.choose',type=>this.play(type?'select':'cancel')),events?.on('audio.scene',state=>this.updateScene(state)),events?.on('connection.status',status=>{if(status!=='connected')this.updateScene({});}),events?.on('notice',()=>this.play('error',.35))].filter(Boolean);}
async unlock(){
  if(this.disposed)return;
  const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Context)return;
  try{
    if(!this.context){
      this.context=new Context();this.master=this.context.createGain();
      this.master.gain.value=.8;this.master.connect(this.context.destination);
      this.context.onstatechange=()=>{this.unlocked=this.context.state==='running';};
    }
    if(this.context.state!=='running')await this.context.resume();
    this.unlocked=this.context.state==='running';
    if(this.unlocked&&!this.welcomed){this.welcomed=true;this.play('confirm');}
  }catch{this.unlocked=false;}
}
now(){return this.context?.currentTime||0;} gain(value,when=this.now()){const node=this.context.createGain();node.gain.setValueAtTime(value,when);node.connect(this.master);return node;}
tone({frequency=220,duration=.1,volume=.1,type='sine',slide=0,when=this.now()}={}){if(!this.unlocked)return;const oscillator=this.context.createOscillator(),gain=this.gain(0,when);oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,when);if(slide)oscillator.frequency.exponentialRampToValueAtTime(Math.max(18,frequency+slide),when+duration);gain.gain.linearRampToValueAtTime(volume,when+.012);gain.gain.exponentialRampToValueAtTime(.0001,when+duration);oscillator.connect(gain);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};oscillator.start(when);oscillator.stop(when+duration+.02);}
noise({duration=.08,volume=.08,cutoff=900,when=this.now()}={}){if(!this.unlocked)return;const length=Math.ceil(this.context.sampleRate*duration),buffer=this.context.createBuffer(1,length,this.context.sampleRate),data=buffer.getChannelData(0);let seed=(Math.floor(when*100000)||1)>>>0;for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=(seed/2147483648-1)*(1-i/length);}const source=this.context.createBufferSource(),filter=this.context.createBiquadFilter(),gain=this.gain(0,when);filter.type='lowpass';filter.frequency.value=cutoff;gain.gain.linearRampToValueAtTime(volume,when+.004);gain.gain.exponentialRampToValueAtTime(.0001,when+duration);source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};source.buffer=buffer;source.connect(filter);filter.connect(gain);source.start(when);source.stop(when+duration+.02);}
play(kind,scale=1){if(!this.unlocked||!kind)return;const t=this.now(),v=clamp(scale);if(kind==='step'){this.sample('step',v*.25,(this.stepVariant=!this.stepVariant)?1:1.08);return;}if(kind==='construct'||kind==='deconstruct'){this.sample('hammer',.65*v);return;}if(kind==='robot'){this.tone({frequency:660,duration:.12,volume:.10,when:t});this.tone({frequency:880,duration:.12,volume:.08,when:t+.22});return;}if(kind==='step'){this.noise({duration:.06,volume:.075*v,cutoff:420,when:t});this.tone({frequency:92,duration:.07,volume:.035*v,type:'triangle',slide:-30,when:t});}else if(kind==='jump'){this.noise({duration:.1,volume:.1*v,cutoff:650,when:t});this.tone({frequency:130,duration:.16,volume:.05*v,type:'triangle',slide:-70,when:t});}else if(kind==='construct'){this.tone({frequency:190,duration:.09,volume:.12*v,type:'square',slide:80,when:t});this.tone({frequency:410,duration:.16,volume:.07*v,type:'sine',slide:170,when:t+.06});this.noise({duration:.07,volume:.09*v,cutoff:1500,when:t+.02});}else if(kind==='deconstruct'){this.tone({frequency:350,duration:.18,volume:.09*v,type:'sawtooth',slide:-190,when:t});this.noise({duration:.12,volume:.08*v,cutoff:800,when:t+.05});}else if(kind==='pickup'||kind==='deposit'){this.tone({frequency:kind==='pickup'?540:360,duration:.09,volume:.09*v,type:'triangle',slide:kind==='pickup'?150:-60,when:t});this.tone({frequency:kind==='pickup'?750:460,duration:.08,volume:.06*v,type:'sine',when:t+.07});}else if(kind==='rover'||kind==='rover-stop')this.tone({frequency:kind==='rover'?115:190,duration:.28,volume:.11*v,type:'sawtooth',slide:kind==='rover'?95:-120,when:t});else if(kind==='scan')this.tone({frequency:430,duration:.28,volume:.08*v,type:'sine',slide:760,when:t});else if(kind==='teleport'||kind==='respawn'){this.noise({duration:.22,volume:.05*v,cutoff:2300,when:t});this.tone({frequency:180,duration:.35,volume:.08*v,type:'sine',slide:620,when:t});}else if(kind==='start'){this.tone({frequency:196,duration:.18,volume:.09*v,type:'sine',slide:95,when:t});this.tone({frequency:392,duration:.28,volume:.07*v,type:'sine',slide:196,when:t+.13});}else if(kind==='select'||kind==='confirm')this.tone({frequency:kind==='select'?440:620,duration:.07,volume:.05*v,type:'sine',slide:kind==='select'?35:75,when:t});else if(kind==='cancel'||kind==='error')this.tone({frequency:kind==='cancel'?260:170,duration:.12,volume:.06*v,type:'triangle',slide:kind==='cancel'?-55:-80,when:t});else if(kind==='camera'||kind==='wake')this.tone({frequency:kind==='camera'?310:260,duration:.08,volume:.04*v,type:'sine',slide:kind==='camera'?80:35,when:t});}
playerInput(input={}){const moving=!!(input.axes?.forward||input.axes?.right),time=performance.now(),cadence=input.running?260:390;if(moving&&time-this.lastStep>=cadence){this.lastStep=time;this.play('step',input.running?1:.75);}if(input.jump&&time-this.lastJump>=450){this.lastJump=time;this.play('jump');}}

buffer(kind){
  if(!this.buffers)this.buffers=new Map();
  if(!this.buffers.has(kind)){
    const samples=makeSamples(kind),buffer=this.context.createBuffer(1,samples.length,24000);
    buffer.getChannelData(0).set(samples);this.buffers.set(kind,buffer);
  }
  return this.buffers.get(kind);
}
sample(kind,volume=1,rate=1){
  const source=this.context.createBufferSource(),gain=this.gain(volume);
  source.buffer=this.buffer(kind);source.playbackRate.value=rate;
  source.connect(gain);source.onended=()=>{source.disconnect();gain.disconnect();};source.start();
}
motion({position,altitude=0,running=false,active=false}={}){
  if(!active||!position||altitude>.08){this.walkPosition=null;this.walkDistance=0;return;}
  if(this.walkPosition){
    const distance=Math.hypot(...position.map((v,i)=>v-this.walkPosition[i]));
    if(distance<1.5)this.walkDistance=(this.walkDistance||0)+distance;
    else this.walkDistance=0;
    if(this.walkDistance>=(running?1.8:1.35)){
      this.walkDistance=0;this.play('step',running?1:.85);
    }
  }
  this.walkPosition=position;
}
makeLoop(kind){
  const gain=this.gain(0),oscillator=this.context.createBufferSource();
  oscillator.buffer=this.buffer(kind);oscillator.loop=true;
  oscillator.connect(gain);oscillator.start();return {gain,oscillator};
}
updateScene(state){if(!this.unlocked)return;const wanted=sceneSoundLevels(state),now=this.now();if(state.robots>0){if(this.nextRobotBeep===undefined)this.nextRobotBeep=now+20;if(now>=this.nextRobotBeep){this.play('robot');this.nextRobotBeep=now+20;}}else this.nextRobotBeep=undefined;for(const [kind,level] of wanted){const loop=this.loops.get(kind)||this.makeLoop(kind);this.loops.set(kind,loop);loop.gain.gain.cancelScheduledValues(now);loop.gain.gain.setTargetAtTime(Math.min(.16,level)*(kind==='drill'||kind==='oxygen_generator'?1.9:.7),now,.12);}for(const [kind,loop]of this.loops)if(!wanted.has(kind)){loop.gain.gain.cancelScheduledValues(now);loop.gain.gain.linearRampToValueAtTime(0,now+.22);}}
dispose(){if(this.disposed)return;this.disposed=true;this.abort.abort();this.unsubs.forEach(unsub=>unsub());for(const loop of this.loops.values()){loop.oscillator.stop();loop.gain.disconnect();}this.loops.clear();this.master?.disconnect();this.context?.close?.();}}

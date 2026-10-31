// Dev-only preview of the real, server-side Goldberg export. No map generation here.
import { Events } from '../net/events.js';
import { byteSize } from '../net/world-cache.js';
import { advance, vector } from './motion.js';
export function createFixture() {
  class Fixture extends Events {
    constructor(){super();this.loaded=new Set();this.requests=new Map();this.active=true;}
    async fetch(path){
      const response=await fetch('/__goldberg/'+path,{cache:'no-store'});
      if(!response.ok)throw Error((await response.json()).error || 'Geometry preview request failed');
      return response.json();
    }
    async connect(){
      try { this.emit('world.offer',await this.fetch('manifest')); }
      catch(error){this.emit('error',error.message);}
    }
    send(){
      if(this.state)return true;
      this.fetch('snapshot').then(state=>{
        if(!this.active)return;
        this.state=state;this.ready=true;
        this.emit('world.snapshot',state);this.emit('status','connected');this.interest();
      }).catch(error=>this.emit('error',error.message));
      return true;
    }
    async interest(){
      if(this.checking || !this.ready)return;
      this.checking=true;
      try {
        const offers=await this.fetch('interest?position='+this.state.players[0].position.join(','));
        if(!this.active)return;
        const allowed=new Set(offers.map(o=>o.chunk_id));
        for(const id of this.loaded)if(!allowed.has(id)){this.loaded.delete(id);this.emit('chunk.unload',{chunk_id:id});}
        for(const offer of offers)if(!this.loaded.has(offer.chunk_id)&&!this.requests.has(offer.chunk_id))this.emit('chunk.offer',offer);
      } catch(error){this.emit('error',error.message);}
      finally{this.checking=false;}
    }
    input({axes,heading}){
      if(!this.state || !this.ready)return;
      // Preview-only motion; production continues to use the real WebSocket transport.
      const player=this.state.players[0];
      const next=advance(vector(player.position),vector(heading),axes,this.state.world.move_speed,.05,this.state.world.radius);
      if(axes.forward || axes.right)player.position=next.position.toArray();
      const delta={players:[structuredClone(player)]};
      this.emit('world.offer',{byte_size:byteSize(delta)});this.emit('world.delta',delta);
      this.elapsed=(this.elapsed||0)+.05;if(this.elapsed>=.5){this.elapsed=0;this.interest();}
    }
    command(type,payload){
      if(type==='chunk.request'){
        const token={};this.requests.set(payload.chunk_id,token);
        this.fetch('chunk?id='+encodeURIComponent(payload.chunk_id)+'&position='+this.state.players[0].position.join(','))
          .then(chunk=>{
            if(!this.active || this.requests.get(payload.chunk_id)!==token)return;
            this.loaded.add(chunk.chunk_id);this.emit('chunk.load',chunk);
          }).catch(error=>{this.emit('chunk.unload',{chunk_id:payload.chunk_id});this.emit('error',error.message);})
          .finally(()=>{if(this.requests.get(payload.chunk_id)===token)this.requests.delete(payload.chunk_id);});
        return;
      }
      if(type==='chunk.release'){this.loaded.delete(payload.chunk_id);this.requests.delete(payload.chunk_id);return;}
      this.emit('message',{type:'action.result',payload:{ok:false,code:'PREVIEW_ONLY',message:'Геометрия настоящая; игровые команды требуют игрового сервера.'}});
    }
    resync(){this.ready=false;this.emit('status','reconnecting');}
    close(){this.active=false;this.ready=false;this.requests.clear();}
  }
  return new Fixture();
}

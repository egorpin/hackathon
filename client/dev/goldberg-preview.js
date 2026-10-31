// Development-only geometry transport. Never included in the production bundle.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
export function goldbergPreview() {
  let world, chunks;
  return {
    name:'goldberg-preview', apply:'serve',
    configureServer(server) {
      server.middlewares.use('/__goldberg', (req,res) => {
        res.setHeader('Cache-Control','no-store');
        res.setHeader('Content-Type','application/json');
        try {
          if (!world) {
            world=JSON.parse(readFileSync(fileURLToPath(new URL('../../world/generated/goldberg.json',import.meta.url)),'utf8'));
            chunks=new Map(world.chunks.map(c=>[c.chunk_id,c]));
            const chunkBytes=world.chunks.reduce((n,c)=>n+bytes(c),0);
            for(let i=0;i<8;i++)world.state.world.total_bytes=chunkBytes+bytes(world.state);
          }
          const url=new URL(req.url,'http://localhost');
          if(url.pathname==='/manifest')return res.end(JSON.stringify({total_bytes:world.state.world.total_bytes,byte_size:bytes(world.state)}));
          if(url.pathname==='/snapshot')return res.end(JSON.stringify(world.state));
          const p=(url.searchParams.get('position')||'').split(',').map(Number);
          if(p.length!==3 || !p.every(Number.isFinite) || Math.hypot(...p)<1)throw Error('Invalid preview position');
          const length=Math.hypot(...p), unit=p.map(v=>v/length), radius=world.state.world.radius;
          const distance=center=>radius*Math.acos(Math.max(-1,Math.min(1,center.reduce((n,v,i)=>n+v*unit[i],0)/Math.hypot(...center))));
          const nearby=world.chunks.map(chunk=>({chunk,distance:Math.min(...chunk.cells.map(cell=>distance(cell.center)))}))
            .filter(e=>e.distance<=world.state.world.view_radius).sort((a,b)=>a.distance-b.distance);
          let budget=world.state.world.total_bytes*.045-bytes(world.state)-2048;
          const selected=nearby.filter(({chunk})=>{const size=bytes(chunk);if(size>budget)return false;budget-=size;return true;});
          if(url.pathname==='/interest') return res.end(JSON.stringify(selected.map(({chunk,distance})=>({chunk_id:chunk.chunk_id,byte_size:bytes(chunk),distance}))));
          if(url.pathname==='/chunk') {
            const id=url.searchParams.get('id');
            if(!nearby.some(e=>e.chunk.chunk_id===id)){res.statusCode=403;return res.end('{}');}
            return res.end(JSON.stringify(chunks.get(id)));
          }
          res.statusCode=404;res.end('{}');
        } catch(error) {res.statusCode=503;res.end(JSON.stringify({error:error.message+'; run npm run world:generate'}));}
      });
    }
  };
}

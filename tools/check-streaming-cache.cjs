// Isolated real-browser streaming/cache smoke. No existing save is used.
// PLAYWRIGHT_MODULE may point at the bundled Playwright installation.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');

const root=path.resolve(__dirname,'..');
const output=path.join(root,'client/test-results/streaming-cache');
fs.mkdirSync(output,{recursive:true});
const data=fs.mkdtempSync(path.join(output,'database-'));
const backendPort=Number(process.env.STREAMING_BACKEND_PORT || 18191);
const frontendPort=Number(process.env.STREAMING_FRONTEND_PORT || 15191);
const url=`http://127.0.0.1:${frontendPort}`;
const children=[];
function start(command,args,env,name){
  const child=spawn(command,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=fs.createWriteStream(path.join(output,name+'.log'));
  child.stdout.pipe(log);child.stderr.pipe(log);child.on('error',error=>console.error(name,error));children.push(child);
}
async function ready(address){
  for(let i=0;i<100;i++){
    try{if((await fetch(address,{signal:AbortSignal.timeout(1500)})).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error(`Server did not start: ${address}`);
}

(async()=>{
  let browser,page; const errors=[],responses=[];
  try{
    console.log('[1/5] Starting isolated servers');
    start(path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),
      ['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(backendPort)],
      {PYTHONPATH:path.join(root,'server'),DATA_DIR:data,STATIC_DIR:path.join(data,'no-static'),MARS_ALLOWED_ORIGINS:url},'backend');
    start(process.execPath,[path.join(root,'client/node_modules/vite/bin/vite.js'),path.join(root,'client'),'--host','127.0.0.1','--port',String(frontendPort),'--strictPort'],
      {MARS_BACKEND_URL:`http://127.0.0.1:${backendPort}`},'frontend');
    await Promise.all([ready(url),ready(`http://127.0.0.1:${backendPort}/api/health`)]);
    browser=await chromium.launch({channel:process.env.STREAMING_BROWSER || 'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
    const context=await browser.newContext({viewport:{width:1440,height:960}});
    page=await context.newPage();page.setDefaultTimeout(30000);
    page.on('pageerror',error=>errors.push(error.message));
    // The anonymous session probe returns 401 before registration; a missing
    // favicon can also log a harmless 404. Keep actual JS and model failures.
    page.on('console',message=>{
      const text=message.text(), location=message.location();
      if(message.type()==='error' && !/\/api\/auth\/me(?:\?|$)|\/favicon\.ico(?:\?|$)/.test(location.url || '') && !/^Failed to load resource: the server responded with a status of (401|404)/.test(text))errors.push(text);
    });
    page.on('requestfailed',request=>{
      if(/\/assets\/models\//.test(request.url()))errors.push(`Model request failed: ${request.url()} ${request.failure()?.errorText || ''}`);
    });
    page.on('response',response=>{if(/\/assets\/models\/.*\.glb(?:\?|$)/.test(response.url())){
      responses.push({url:response.url(),status:response.status(),phase:phase});
      if(!response.ok())errors.push(`Model HTTP ${response.status()}: ${response.url()}`);
    }});
    let phase='cold';
    await page.addInitScript(()=>{
      window.qa={incoming:{},outgoing:{},closes:[],notices:[],modelErrors:[],stats:[],performance:[],samples:[],state:null};
      const Socket=window.WebSocket;
      window.WebSocket=class extends Socket{
        constructor(...args){super(...args);this.addEventListener('message',event=>{
          try{const m=JSON.parse(event.data);window.qa.incoming[m.type]=(window.qa.incoming[m.type]||0)+1;}catch{}
        });this.addEventListener('close',event=>window.qa.closes.push({code:event.code,reason:event.reason}));}
        send(data){try{const m=JSON.parse(data);window.qa.outgoing[m.type]=(window.qa.outgoing[m.type]||0)+1;}catch{}return super.send(data);}
      };
    });
    const observe=async()=>page.evaluate(async()=>{
      const {WorldScene}=await import('/src/scene/world-scene.js');
      const original=WorldScene.prototype.select;
      WorldScene.prototype.select=function(...args){window.qa.scene=this;return original.apply(this,args);};
      const events=window.marsClient.events;
      events.on('world.state',state=>window.qa.state=state);
      events.on('cache.stats',stats=>window.qa.stats.push(stats));
      events.on('performance',stats=>window.qa.performance.push(stats));
      events.on('notice',notice=>window.qa.notices.push(String(notice)));
      events.emit('build.type',null);
      // Observe the existing load promise; do not initiate a second model load.
      window.qa.scene.models.loading?.catch(error=>window.qa.modelErrors.push({message:String(error),nested:[...(error.errors || [])].map(String)}));
    });
    const waitAssets=async()=>{
      const expected=await page.evaluate(async()=>{
        const manifest=await (await fetch('/assets/models/manifest.json',{cache:'no-store'})).json();
        const {MODEL_NAMES}=await import('/src/scene/model-library.js');
        return MODEL_NAMES.filter(name=>manifest.approved?.includes(name));
      });
      assert.ok(expected.length>0,'manifest must approve at least one model');
      try {
        await page.waitForFunction(names=>names.every(name=>window.qa.scene.models.assets.has(name)),expected,{timeout:30000});
      } catch(error) {
        const diagnostic=await page.evaluate(()=>({loaded:[...window.qa.scene.models.assets.keys()],cache:window.qa.scene.models.cache?.stats,notices:window.qa.notices,modelErrors:window.qa.modelErrors}));
        throw Error(`Models did not load: expected ${JSON.stringify(expected)}; diagnostic ${JSON.stringify(diagnostic)}; ${error.message}`);
      }
    };
    const waitScene=async()=>{
      await page.waitForFunction(()=>!!window.marsClient);await observe();
      await page.waitForFunction(()=>window.qa.scene?.enabled && window.qa.scene.chunks.size>0,null,{timeout:45000});
      // The snapshot, terrain offers and asset loading are independent operations.
      await waitAssets();
    };
    const sample=()=>page.evaluate(()=>{
      const scene=window.qa.scene, origin=scene.authoritative || scene.position, radius=scene.radius;
      let best=null;
      for(const entry of scene.chunks.values())for(const tile of entry.cells){
        const c=tile.userData.cell, center=c.center;
        const dot=(origin.x*center[0]+origin.y*center[1]+origin.z*center[2])/(origin.length()*Math.hypot(...center));
        const distance=radius*Math.acos(Math.max(-1,Math.min(1,dot)));
        const edge=Math.hypot(...c.vertices[0].map((v,i)=>v-center[i]));
        if(!best || distance<best.distance)best={distance,edge,id:c.cell_id,visible:tile.visible};
      }
      const value={time:performance.now(),position:origin.toArray(),altitude:scene.altitude||0,chunks:scene.chunks.size,nearest:best};
      window.qa.samples.push(value);return value;
    });
    console.log('[2/5] Registering and loading landing area');
    await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.marsClient);await observe();
    await page.locator('[name=username]').fill('streaming_qa');
    await page.locator('[name=password]').fill('streaming-test-123');
    await page.locator('button[value=register]').click();
    await page.locator('.ready-button:not([disabled])').waitFor();await page.locator('.ready-button').click();
    await page.waitForFunction(()=>window.qa.state?.stage==='running',null,{timeout:45000});
    await page.locator('.player-lobby').waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.qa.scene?.chunks.size>0,null,{timeout:45000});
    await waitAssets();
    await page.waitForTimeout(1500);const landing=await sample();
    assert.ok(landing.nearest && landing.nearest.distance<=landing.nearest.edge*1.5,'landing area must have a nearby streamed tile');
    await page.screenshot({path:path.join(output,'landing.png')});
    console.log('[3/5] Sprinting, jumping, changing direction and returning');
    const startPosition=landing.position;
    await page.keyboard.down('Shift');
    for(const key of ['KeyW','KeyD','KeyS']){
      await page.keyboard.down(key);
      for(let n=0;n<5;n++){
        await page.keyboard.down('Space');await page.waitForTimeout(180);await sample();
        await page.keyboard.up('Space');await page.waitForTimeout(520);await sample();
      }
      await page.keyboard.up(key);
    }
    await page.keyboard.up('Shift');
    await page.waitForTimeout(2500);const settled=await sample();
    assert.ok(settled.nearest && settled.nearest.visible && settled.nearest.distance<=settled.nearest.edge*1.5,'settled player must have local streamed ground');
    const moved=Math.hypot(...settled.position.map((v,i)=>v-startPosition[i]));
    assert.ok(moved>2,`test player must actually move (distance ${moved})`);
    await page.screenshot({path:path.join(output,'after-sprint.png')});
    const cold=await page.evaluate(()=>({incoming:window.qa.incoming,outgoing:window.qa.outgoing,closes:window.qa.closes,notices:window.qa.notices,stats:window.qa.stats,performance:window.qa.performance,samples:window.qa.samples,assets:[...window.qa.scene.models.assets].map(([name,asset])=>{
      let textures=0;asset.scene.traverse(node=>{for(const material of [node.material].flat().filter(Boolean))for(const value of Object.values(material))if(value?.isTexture && value.image)textures++;});return {name,textures};
    }),resources:performance.getEntriesByType('resource').filter(e=>/\.glb(?:\?|$)/.test(e.name)).map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize}))}));
    assert.ok((cold.incoming['chunk.offer']||0)>0 && (cold.incoming['chunk.load']||0)>0,'stream must offer and load chunks');
    assert.ok(cold.stats.length && Math.max(...cold.stats.map(s=>s.percent))<=10.00001,'world cache must stay at or below 10%');
    let missingRun=0,maxMissingRun=0;
    for(const sample of cold.samples){
      const n=sample.nearest;
      missingRun=n && n.visible && n.distance<=n.edge*1.5 ? 0 : missingRun+1;
      maxMissingRun=Math.max(maxMissingRun,missingRun);
    }
    cold.maxMissingRun=maxMissingRun;
    assert.ok(maxMissingRun<=3,`local streamed ground missing for ${maxMissingRun} consecutive samples`);
    assert.ok(!cold.notices.some(n=>/отклон|ошиб|resync/i.test(n)),`streaming notices: ${cold.notices.join('; ')}`);
    assert.ok(!cold.closes.some(c=>c.code===4000),`unexpected resync: ${JSON.stringify(cold.closes)}`);
    assert.ok(cold.samples.some(s=>s.altitude>.05),'test player must actually jump');
    console.log('[4/5] Warm reload and model verification');
    phase='warm';await page.reload({waitUntil:'domcontentloaded'});await waitScene();await page.waitForTimeout(2500);
    await page.screenshot({path:path.join(output,'warm-reload.png')});
    const warm=await page.evaluate(()=>{
      const scene=window.qa.scene;
      const assets=[...scene.models.assets].map(([name,asset])=>{
        let meshes=0,textures=0;asset.scene.traverse(node=>{if(node.isMesh)meshes++;for(const material of [node.material].flat().filter(Boolean))for(const value of Object.values(material))if(value?.isTexture && value.image)textures++;});
        return {name,meshes,textures,cloneUsable:!!scene.models.create(name)};
      });
      return {assets,cache:scene.models.cache?.stats,notices:window.qa.notices,resources:performance.getEntriesByType('resource').filter(e=>/\.glb(?:\?|$)/.test(e.name)).map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize}))};
    });
    assert.deepEqual(warm.assets.map(a=>a.name).sort(),cold.assets.map(a=>a.name).sort(),'all cold models must load after reload');
    assert.ok(warm.assets.every(a=>a.meshes>0 && a.cloneUsable),'models must be usable after reload');
    assert.deepEqual(warm.assets.map(({name,textures})=>({name,textures})).sort((a,b)=>a.name.localeCompare(b.name)),cold.assets.sort((a,b)=>a.name.localeCompare(b.name)),'texture references must survive reload');
    assert.ok(warm.cache?.hits>=warm.assets.length && warm.cache?.misses===0,`expected persistent model cache hits: ${JSON.stringify(warm.cache)}`);
    assert.equal(responses.filter(r=>r.phase==='warm').length,0,'warm reload must not request GLBs');
    assert.ok(!warm.notices.some(n=>/модели недоступны/i.test(n)),'model parse/load failure');
    // Render the actual scene's crater branch in isolation; reuse a streamed tile's
    // world coordinates, since real inactive pentagons may be outside interest.
    await page.evaluate(async()=>{
      const THREE=await import('/node_modules/three/build/three.module.js');
      const scene=window.qa.scene,tiles=[...scene.chunks.values()].flatMap(entry=>entry.cells);
      const source=tiles.find(tile=>tile.userData.cell.vertices.length===5) || tiles[0];
      const cell={...source.userData.cell,cell_id:'qa-crater-preview',surface:'mountain',resource:null,vertices:source.userData.cell.vertices.slice(0,5)};
      scene.renderer.setAnimationLoop(null);
      scene.load({chunk_id:'qa-crater-preview',cells:[cell]});
      const entry=scene.chunks.get('qa-crater-preview'),tile=entry.cells[0];
      for(const chunk of scene.chunks.values())if(chunk!==entry)chunk.group.visible=false;
      tile.visible=true;tile.userData.decoration.visible=true;
      scene.atmosphere.sky.visible=false;scene.atmosphere.dust.visible=false;
      scene.hands.root && (scene.hands.root.visible=false);
      const center=new THREE.Vector3().fromArray(cell.center),up=center.clone().normalize();
      const edge=new THREE.Vector3().fromArray(cell.vertices[0]).distanceTo(center);
      const direction=new THREE.Vector3().fromArray(cell.vertices[0]).sub(center).normalize();
      scene.camera.position.copy(center).addScaledVector(up,edge*3).addScaledVector(direction,edge*1.7);
      scene.camera.up.copy(up);scene.camera.lookAt(center);scene.camera.updateMatrixWorld();
      scene.renderer.render(scene.scene,scene.camera);
    });
    await page.screenshot({path:path.join(output,'crater-preview.png')});
    assert.deepEqual(errors,[],'browser errors');
    const result={ok:true,data,moved,cold,warm,responses,notes:'Resource Timing transferSize may be zero for memory/HTTP cache; response records alone do not prove bytes transferred. Coverage samples use nearest tile center and are a coarse geometric proxy.'};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
    console.log('[5/5] Passed. Metrics and screenshots: '+output);
  }catch(error){
    if(page){
      await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
      const partial=await page.evaluate(()=>window.qa && ({incoming:window.qa.incoming,outgoing:window.qa.outgoing,closes:window.qa.closes,notices:window.qa.notices,modelErrors:window.qa.modelErrors,stats:window.qa.stats,performance:window.qa.performance,samples:window.qa.samples})).catch(()=>null);
      fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),partial,errors,responses},null,2));
    }
    throw error;
  }finally{await browser?.close();for(const child of children)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});

// Real browser + WebSocket smoke test, with a fresh disposable database per run.
// PLAYWRIGHT_MODULE can point at the bundled Codex runtime's playwright package.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');

const root=path.resolve(__dirname,'..');
const output=path.join(root,'client/test-results/economy');
fs.mkdirSync(output,{recursive:true});
const data=fs.mkdtempSync(path.join(output,'database-'));
const backendPort=Number(process.env.ECONOMY_BACKEND_PORT || 18189);
const frontendPort=Number(process.env.ECONOMY_FRONTEND_PORT || 15189);
const url=`http://127.0.0.1:${frontendPort}`;
const children=[];
function start(command,args,env,name){
  const child=spawn(command,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=fs.createWriteStream(path.join(output,name+'.log'));
  child.stdout.pipe(log);child.stderr.pipe(log);children.push(child);
  child.on('error',error=>console.error(name,error));
  return child;
}
async function waitForServer(address){
  for(let attempt=0;attempt<100;attempt++){
    try{if((await fetch(address)).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error(`Server did not start: ${address}`);
}

(async()=>{
  let browser,page;
  try{
    start(path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),
      ['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(backendPort)],
      {PYTHONPATH:path.join(root,'server'),DATA_DIR:data,STATIC_DIR:path.join(data,'no-static'),MARS_ALLOWED_ORIGINS:url},'backend');
    start(process.execPath,[path.join(root,'client/node_modules/vite/bin/vite.js'),path.join(root,'client'),'--host','127.0.0.1','--port',String(frontendPort),'--strictPort'],
      {MARS_BACKEND_URL:`http://127.0.0.1:${backendPort}`},'frontend');
    await Promise.all([waitForServer(url),waitForServer(`http://127.0.0.1:${backendPort}/api/health`)]);
    console.log('Isolated servers ready; starting browser.');
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
    page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const NativeSocket=window.WebSocket;
      window.qa={results:{},cells:{},sent:[]};
      window.WebSocket=class extends NativeSocket{
        constructor(...args){super(...args);this.addEventListener('message',event=>{
          const message=JSON.parse(event.data);
          if(message.type==='action.result')window.qa.results[message.request_id]=message.payload;
          if(message.type==='chunk.load')for(const cell of message.payload.cells)window.qa.cells[cell.cell_id]=cell;
        });}
        send(data){window.qa.sent.push(JSON.parse(data));return super.send(data);}
      };
    });
    await page.goto(url);
    await page.waitForFunction(()=>!!window.marsClient);
    const observe=async()=>page.evaluate(async()=>{
      window.marsClient.events.on('world.state',state=>window.qa.state=state);
      const {WorldScene}=await import('/src/scene/world-scene.js');
      const original=WorldScene.prototype.select;
      WorldScene.prototype.select=function(...args){window.qa.scene=this;return original.apply(this,args);};
      window.marsClient.events.emit('build.type',null);
    });
    await observe();
    await page.locator('[name=username]').fill('economy_qa');
    await page.locator('[name=password]').fill('economy-test-123');
    await page.locator('button[value=register]').click();
    await page.locator('.ready-button:not([disabled])').waitFor();
    await page.locator('.ready-button').click();
    await page.waitForFunction(()=>window.qa.state?.stage==='running');
    await page.locator('.player-lobby').waitFor({state:'hidden'});
    await page.locator('.economy-hud').waitFor();
    console.log('Registration, lobby and running state passed.');
    assert.deepEqual(await page.evaluate(()=>Object.fromEntries(['iron','sulfur','water'].map(key=>[key,window.qa.state.team_storage[key]]))),{iron:40,sulfur:15,water:5});
    assert.match(await page.locator('[data-building=oxygen_generator] .build-cost').innerText(),/15.*5/);
    assert.equal(await page.evaluate(()=>window.qa.state.config.storage_capacity),300);
    const settle=async id=>{
      await page.waitForFunction(id=>!!window.qa.results[id],id);
      const result=await page.evaluate(id=>window.qa.results[id],id);
      assert.equal(result.ok,true,JSON.stringify(result));return result;
    };
    const command=async(type,payload)=>settle(await page.evaluate(({type,payload})=>window.marsClient.command(type,payload),{type,payload}));
    const build=async(type,resource,adjacentTo)=>{
      const id=await page.evaluate(({type,resource,adjacentTo})=>{
        const {state,scene,cells}=window.qa;
        const player=state.players.find(p=>p.player_id===state.self_id),r=state.world.radius;
        const distance=c=>r*Math.acos(Math.min(1,Math.max(-1,c.center.reduce((sum,v,i)=>sum+v*player.position[i],0)/(Math.hypot(...c.center)*Math.hypot(...player.position)))));
        const adjacentCell=adjacentTo&&cells[state.buildings.find(b=>b.building_id===adjacentTo).cell_id];
        const cell=Object.values(cells).filter(c=>c.buildable&&(!resource||c.resource===resource)&&(!adjacentCell||adjacentCell.neighbors.includes(c.cell_id))&&!state.buildings.some(b=>b.cell_id===c.cell_id)&&distance(c)<=state.world.build_distance&&distance(c)>=2).sort((a,b)=>distance(a)-distance(b))[0];
        if(!cell)throw Error(`No reachable free cell for ${type}/${resource}`);
        window.marsClient.events.emit('build.cancel');
        window.marsClient.events.emit('build.choose',type);
        scene.select(cell);
        if(document.getElementById('build').disabled)throw Error('Build button disabled for affordable reachable cell');
        document.getElementById('build').click();
        return window.qa.sent.at(-1).request_id;
      },{type,resource,adjacentTo});
      const result=await settle(id);
      await page.waitForFunction(id=>window.qa.state.buildings.some(b=>b.building_id===id),result.building_id);
      return result.building_id;
    };
    const remove=async id=>{
      const before=await page.evaluate(id=>{
        const state=window.qa.state,b=state.buildings.find(b=>b.building_id===id);
        return {pool:state.team_storage,cost:state.config.recipes[b.building_type],stock:b.building_type==='warehouse'?{}:b.stock};
      },id);
      await page.evaluate(id=>window.marsClient.events.emit('building.selected',window.qa.state.buildings.find(b=>b.building_id===id)),id);
      await page.locator('.building-panel').waitFor();
      assert.equal(await page.evaluate(()=>window.qa.scene.controls.suspended),true);
      await page.locator('#building-remove').click();
      await page.waitForFunction(id=>!window.qa.state.buildings.some(b=>b.building_id===id),id);
      await page.locator('.building-panel').waitFor({state:'hidden'});
      const after=await page.evaluate(()=>window.qa.state.team_storage);
      for(const resource of ['iron','sulfur'])assert.equal(after[resource],before.pool[resource]+(before.cost[resource]||0)+(before.stock[resource]||0),'paid building costs must be refunded');
    };
    const aim=async id=>{
      await page.evaluate(async id=>{
        const {Vector3,Box3}=await import('/node_modules/three/build/three.module.js');
        const {EYE_HEIGHT}=await import('/src/scene/character-scale.js');
        const scene=window.qa.scene,mesh=scene.buildings.get(id).mesh;
        const target=new Box3().setFromObject(mesh).getCenter(new Vector3());
        const up=scene.position.clone().normalize();
        const direction=target.sub(scene.position.clone().addScaledVector(up,EYE_HEIGHT)).normalize();
        const vertical=direction.dot(up),horizontal=direction.clone().addScaledVector(up,-vertical);
        scene.heading.copy(horizontal.normalize());scene.controls.pitch=Math.asin(vertical);
        window.marsClient.events.emit('build.cancel');
      },id);
      await page.waitForFunction(id=>window.qa.scene.targetedBuilding?.building_id===id,id);
      await page.locator('#resource-transfer:not([hidden])').waitFor();
    };
    const transfer=async id=>{
      await aim(id);
      await page.locator('#resource-transfer:not([disabled])').waitFor();
      await page.locator('#resource-transfer').click();
      const requestId=await page.evaluate(()=>window.qa.sent.filter(m=>m.type==='resource.pickup'||m.type==='resource.deposit').at(-1).request_id);
      await settle(requestId);
    };
    const keyboardDeposit=async id=>{
      await aim(id);
      await page.keyboard.press('KeyE');
      await page.locator('.building-panel').waitFor();
      await page.locator('#building-deposit:not([disabled])').waitFor();
      await page.keyboard.press('KeyE');
      await page.locator('.building-panel').waitFor({state:'hidden'});
      const requestId=await page.evaluate(()=>window.qa.sent.filter(m=>m.type==='resource.deposit').at(-1).request_id);
      await settle(requestId);
    };
    const water=await build('drill','water');
    await page.waitForFunction(id=>window.qa.state.buildings.find(b=>b.building_id===id)?.stock.water>=3,water);
    assert.equal(await page.evaluate(()=>window.qa.state.team_storage.water),5,'drill must keep water locally');
    await aim(water);
    await page.keyboard.press('KeyE');
    await page.locator('.building-panel').waitFor();
    const pickupsBefore=await page.evaluate(()=>window.qa.sent.filter(m=>m.type==='resource.pickup').length);
    await page.locator('.building-panel-close').dispatchEvent('keydown',{code:'KeyE',key:'e',repeat:true,bubbles:true});
    assert.equal(await page.evaluate(()=>window.qa.sent.filter(m=>m.type==='resource.pickup').length),pickupsBefore,'holding E must not pick up resources');
    await page.keyboard.press('KeyE');
    await page.locator('.building-panel').waitFor({state:'hidden'});
    const pickupId=await page.evaluate(()=>window.qa.sent.filter(m=>m.type==='resource.pickup').at(-1).request_id);
    await settle(pickupId);
    await page.waitForFunction(()=>window.qa.state.inventory.water>=3);
    console.log('Raycast pickup and personal inventory passed.');
    assert.equal(await page.evaluate(()=>window.qa.state.team_storage.water),5,'pickup must only fill personal inventory');
    const generator=await build('oxygen_generator');
    await keyboardDeposit(generator);
    await page.waitForFunction(()=>window.qa.state.inventory.water===0);
    await page.waitForFunction(()=>window.qa.state.oxygen_percent>=.1);
    assert.equal(await page.evaluate(()=>window.qa.state.team_storage.water),5,'unconnected generator must not draw team water');
    console.log('Direct generator water delivery passed.');
    assert.match(await page.locator('#planet-oxygen').innerText(),/0[.,][1-9]/);
    const warehouse=await build('warehouse',null,generator);
    await page.waitForFunction(()=>window.qa.state.config.storage_capacity===500);
    assert.equal(await page.evaluate(()=>window.qa.state.config.storage_capacity),500);
    await page.waitForFunction(()=>window.qa.state.team_storage.water<5);
    await page.waitForFunction(id=>window.qa.state.buildings.find(b=>b.building_id===id)?.stock.water>=1,water);
    await transfer(water);
    await page.waitForFunction(()=>window.qa.state.inventory.water>=1);
    await keyboardDeposit(warehouse);
    await page.waitForFunction(()=>window.qa.state.inventory.water===0);
    console.log('Adjacent warehouse supply and manual unloading passed.');
    await aim(water);
    await page.screenshot({path:path.join(output,'desktop-production.png')});
    await remove(generator);
    await remove(water);
    await remove(warehouse);
    await page.waitForFunction(()=>window.qa.state.config.storage_capacity===300);
    const base=await build('dome_base');
    await page.locator('#settings-toggle').click();
    await page.screenshot({path:path.join(output,'desktop-settings.png')});
    await page.locator('#player-respawn').click();
    const respawnId=await page.evaluate(()=>window.qa.sent.filter(m=>m.type==='player.respawn').at(-1).request_id);
    assert.equal((await settle(respawnId)).building_id,base);
    await page.evaluate(()=>window.marsClient.events.emit('build.cancel'));
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'mobile-economy.png')});
    const horizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert.equal(horizontalOverflow,false);
    const storage=await page.evaluate(()=>window.qa.state.team_storage);
    await page.reload();await page.waitForFunction(()=>!!window.marsClient);await observe();
    await page.waitForFunction(()=>!!window.qa.state);
    assert.deepEqual(await page.evaluate(()=>window.qa.state.team_storage),storage,'reconnect must not grant resources again');
    assert.deepEqual(errors,[],'browser errors');
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks:['auth/lobby','shared recipes','drill local stock','raycast aim pickup','personal inventory','direct generator unload','adjacent warehouse supply','warehouse unload','demolition refunds','warehouse capacity','base respawn','reconnect grant idempotency','desktop/mobile rendering'],data},null,2));
    console.log('Economy browser smoke passed. Screenshots: '+output);
  }catch(error){
    if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    throw error;
  }finally{
    await browser?.close();for(const child of children)child.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

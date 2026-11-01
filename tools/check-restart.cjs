// Isolated two-player restart smoke test. PLAYWRIGHT_MODULE may point at bundled Playwright.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'client/test-results/restart');
fs.mkdirSync(output,{recursive:true});
const data=fs.mkdtempSync(path.join(output,'database-'));
const backendPort=Number(process.env.RESTART_BACKEND_PORT || 18190);
const frontendPort=Number(process.env.RESTART_FRONTEND_PORT || 15190);
const url=`http://127.0.0.1:${frontendPort}`;
const children=[];
function start(command,args,env,name){
  const child=spawn(command,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=fs.createWriteStream(path.join(output,name+'.log'));
  child.stdout.pipe(log);child.stderr.pipe(log);children.push(child);
  child.on('error',error=>console.error(name,error));
}
async function waitForServer(address){
  for(let i=0;i<100;i++){
    try{if((await fetch(address)).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error(`Server did not start: ${address}`);
}
(async()=>{
  let browser,first,second;
  const errors=[];
  try{
    start(path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),
      ['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(backendPort)],
      {PYTHONPATH:path.join(root,'server'),DATA_DIR:data,STATIC_DIR:path.join(data,'no-static'),MARS_ALLOWED_ORIGINS:url},'backend');
    start(process.execPath,[path.join(root,'client/node_modules/vite/bin/vite.js'),path.join(root,'client'),'--host','127.0.0.1','--port',String(frontendPort),'--strictPort'],
      {MARS_BACKEND_URL:`http://127.0.0.1:${backendPort}`},'frontend');
    await Promise.all([waitForServer(url),waitForServer(`http://127.0.0.1:${backendPort}/api/health`)]);
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
    async function newPlayer(name,expectLobby=true){
      const context=await browser.newContext({viewport:{width:1440,height:960}});
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(`${name}: ${error.message}`));
      await page.addInitScript(()=>{
        const NativeSocket=window.WebSocket;window.qa={results:{},cells:{},sent:[]};
        window.WebSocket=class extends NativeSocket{
          constructor(...args){super(...args);this.addEventListener('message',event=>{
            const message=JSON.parse(event.data);
            if(message.type==='lobby.state')window.qa.lobby=message.payload;
            if(message.type==='action.result')window.qa.results[message.request_id]=message.payload;
            if(message.type==='chunk.load')for(const cell of message.payload.cells)window.qa.cells[cell.cell_id]=cell;
          });}
          send(data){window.qa.sent.push(JSON.parse(data));return super.send(data);}
        };
      });
      await page.goto(url);await observe(page);
      await page.locator('[name=username]').fill(name);
      await page.locator('[name=password]').fill('restart-test-123');
      await page.locator('button[value=register]').click();
      if(expectLobby)await page.locator('.ready-button:not([disabled])').waitFor();
      return page;
    }
    async function observe(page){
      await page.waitForFunction(()=>!!window.marsClient);
      await page.evaluate(async()=>{
        window.marsClient.events.on('world.state',state=>window.qa.state=state);
        const {WorldScene}=await import('/src/scene/world-scene.js');
        const original=WorldScene.prototype.select;
        WorldScene.prototype.select=function(...args){window.qa.scene=this;return original.apply(this,args);};
        window.marsClient.events.emit('build.type',null);
      });
    }
    async function readyBoth(){
      for(const page of [first,second])await page.locator('.ready-button:not([disabled])').click();
      for(const page of [first,second]){
        await page.waitForFunction(()=>window.qa.state?.stage==='running');
        await page.locator('.player-lobby').waitFor({state:'hidden'});
      }
    }
    async function build(page,type){
      // World snapshots and nearby terrain chunks arrive independently, especially on reload.
      await page.waitForFunction(()=>{
        const {state,scene,cells}=window.qa;
        if(!state?.world||!scene||!cells)return false;
        const player=state.players.find(p=>p.player_id===state.self_id);
        if(!player)return false;
        const r=state.world.radius;
        const distance=c=>r*Math.acos(Math.min(1,Math.max(-1,c.center.reduce((sum,v,i)=>sum+v*player.position[i],0)/(Math.hypot(...c.center)*Math.hypot(...player.position)))));
        return Object.values(cells).some(c=>c.buildable&&!state.buildings.some(b=>b.cell_id===c.cell_id)&&distance(c)<=state.world.build_distance&&distance(c)>=2);
      },null,{timeout:20000});
      const id=await page.evaluate(type=>{
        const {state,scene,cells}=window.qa;
        const player=state.players.find(p=>p.player_id===state.self_id),r=state.world.radius;
        const distance=c=>r*Math.acos(Math.min(1,Math.max(-1,c.center.reduce((sum,v,i)=>sum+v*player.position[i],0)/(Math.hypot(...c.center)*Math.hypot(...player.position)))));
        const cell=Object.values(cells).filter(c=>c.buildable&&!state.buildings.some(b=>b.cell_id===c.cell_id)&&distance(c)<=state.world.build_distance&&distance(c)>=2).sort((a,b)=>distance(a)-distance(b))[0];
        if(!cell)throw Error('No reachable free cell');
        window.marsClient.events.emit('build.cancel');window.marsClient.events.emit('build.choose',type);scene.select(cell);
        if(document.getElementById('build').disabled)throw Error('Build button disabled');
        document.getElementById('build').click();return window.qa.sent.at(-1).request_id;
      },type);
      await page.waitForFunction(id=>!!window.qa.results[id],id);
      const result=await page.evaluate(id=>window.qa.results[id],id);
      assert.equal(result.ok,true,JSON.stringify(result));
      await page.waitForFunction(id=>window.qa.state.buildings.some(b=>b.building_id===id),result.building_id);
      return result.building_id;
    }
    first=await newPlayer('restart_qa_one');second=await newPlayer('restart_qa_two');
    await first.waitForFunction(()=>window.qa.lobby?.players.length===2);
    console.log('Two players registered.');
    await readyBoth();
    const initial=await first.evaluate(()=>({...window.qa.state.team_storage}));
    assert.deepEqual(Object.fromEntries(['iron','sulfur','water'].map(k=>[k,initial[k]])),{iron:80,sulfur:30,water:10});
    const building=await build(first,'oxygen_generator');
    const secondBuilding=await build(second,'dome_base');
    await first.waitForFunction(()=>window.qa.state.team_storage.iron===55);
    console.log('Both players built locally.');
    const before=await first.evaluate(()=>({storage:{...window.qa.state.team_storage},buildings:window.qa.state.buildings.map(b=>b.building_id)}));
    await first.locator('.player-chip').click();await first.locator('.restart-button').click();
    await first.locator('.restart-confirm').waitFor();
    await first.screenshot({path:path.join(output,'confirmation.png')});
    await first.locator('.restart-cancel').click();
    await first.locator('.restart-confirm').waitFor({state:'hidden'});
    assert.deepEqual(await first.evaluate(()=>({storage:{...window.qa.state.team_storage},buildings:window.qa.state.buildings.map(b=>b.building_id)})),before,'cancel must preserve progress');
    assert.ok(await second.evaluate(id=>window.qa.state.buildings.some(b=>b.building_id===id),secondBuilding),'cancel preserves second player building');
    console.log('Cancel preserves both players progress.');
    await first.locator('.lobby-close').click();await first.locator('.player-lobby').waitFor({state:'hidden'});
    await second.evaluate(id=>window.marsClient.events.emit('building.selected',window.qa.state.buildings.find(b=>b.building_id===id)),secondBuilding);
    await second.locator('.building-panel').waitFor();
    await first.locator('.player-chip').click();await first.locator('.restart-button').click();await first.locator('.restart-confirm-button').click();
    for(const page of [first,second]){
      await page.locator('.player-lobby').waitFor({state:'visible'});
      await page.waitForFunction(()=>window.qa.state?.stage==='lobby'&&window.qa.state.buildings.length===0);
      await page.locator('.ready-button:not([disabled])').waitFor();
      assert.deepEqual(await page.evaluate(()=>window.qa.state.team_storage),initial,'restart restores starter pool');
      assert.equal(await page.evaluate(()=>window.qa.state.oxygen_percent),0);
      assert.ok(Object.values(await page.evaluate(()=>window.qa.state.inventory)).every(value=>value===0),'personal inventory resets');
      assert.equal(await page.locator('.ready-status.is-ready').count(),0,'readiness resets');
    }
    await second.locator('.building-panel').waitFor({state:'hidden'});
    console.log('Reset returned both players to lobby.');
    await first.screenshot({path:path.join(output,'new-lobby.png')});
    await first.reload();await observe(first);
    await first.waitForFunction(()=>window.qa.state?.stage==='lobby');
    assert.deepEqual(await first.evaluate(()=>window.qa.state.team_storage),initial,'reconnect must not grant starter resources again');
    await first.locator('.ready-button:not([disabled])').waitFor();
    await readyBoth();
    const fresh=await build(first,'oxygen_generator');
    assert.ok(fresh,'new round can spend its starter resources');
    const after=await first.evaluate(()=>({...window.qa.state.team_storage}));
    assert.equal(after.iron,initial.iron-15);assert.equal(after.sulfur,initial.sulfur-5);
    console.log('Reconnect and new round passed.');
    // A new account joins an already running round without interrupting either player.
    const third=await newPlayer('restart_qa_three',false);
    await third.waitForFunction(()=>window.qa.state?.stage==='running');
    await third.locator('.player-lobby').waitFor({state:'hidden'});
    await first.waitForFunction(()=>window.qa.lobby?.players.length===3);
    await first.waitForFunction(id=>window.qa.state.buildings.some(b=>b.building_id===id),fresh);
    for(const page of [first,second,third]){
      await page.waitForFunction(()=>window.qa.state?.stage==='running');
      assert.equal(await page.locator('.player-lobby').isVisible(),false,'late join must not impose a ready barrier');
    }
    const joined=await third.evaluate(()=>({...window.qa.state.team_storage}));
    for(const [resource,grant] of Object.entries({iron:40,sulfur:15,water:5}))
      assert.equal(joined[resource],after[resource]+grant,'late player receives one starter grant');
    await third.reload();await observe(third);
    await third.waitForFunction(()=>window.qa.state?.stage==='running');
    assert.deepEqual(await third.evaluate(()=>window.qa.state.team_storage),joined,'late player reconnect must not repeat grant');
    await third.locator('.player-lobby').waitFor({state:'hidden'});
    const thirdBuilding=await build(third,'dome_base');
    assert.ok(thirdBuilding);
    await first.waitForFunction(iron=>window.qa.state.team_storage.iron===iron,joined.iron-10);
    console.log('Late join, reconnect, and local building passed.');
    assert.deepEqual(errors,[],'browser errors');
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks:['two player registration','cancel preserves progress','confirmation','reset all clients and selection','starter pool and inventory','reconnect idempotency','new ready round and building costs','late join without ready barrier','one late join grant','late join gameplay'],data},null,2));
    console.log('Restart browser smoke passed. Screenshots: '+output);
  }catch(error){
    if(first)await first.screenshot({path:path.join(output,'failure-first.png')}).catch(()=>{});
    if(second)await second.screenshot({path:path.join(output,'failure-second.png')}).catch(()=>{});
    throw error;
  }finally{await browser?.close();for(const child of children)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});

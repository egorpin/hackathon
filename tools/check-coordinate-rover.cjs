// Disposable browser smoke; creates its own DATA_DIR and never opens the live save.
// Run after `npm --prefix client run build` with PLAYWRIGHT_MODULE pointing to Playwright.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/rover-review');
fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(out,'fixture-db-'));
const port=Number(process.env.ROVER_PORT||18207),url=`http://127.0.0.1:${port}`;
const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const child=spawn(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(port)],{cwd:root,windowsHide:true,env:{...process.env,PYTHONPATH:path.join(root,'server'),DATA_DIR:data,STATIC_DIR:path.join(root,'client/dist'),MARS_ALLOWED_ORIGINS:url},stdio:['ignore','pipe','pipe']});
const log=fs.createWriteStream(path.join(out,'server.log'));child.stdout.pipe(log);child.stderr.pipe(log);
async function ready(){for(let i=0;i<100;i++){try{if((await fetch(url+'/api/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,200))}throw Error('Server failed to start')}
(async()=>{let browser,page;const errors=[];try{
 await ready();browser=await chromium.launch({channel:process.env.ROVER_BROWSER||'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.qa={results:{},sent:[]};const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(...args){super(...args);this.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.type==='action.result')window.qa.results[m.request_id]=m.payload}catch{}})}send(data){try{window.qa.sent.push(JSON.parse(data))}catch{}return super.send(data)}}});
 await page.goto(url);await page.waitForFunction(()=>window.marsClient);await page.evaluate(()=>window.marsClient.events.on('world.state',s=>window.qa.state=s));
 await page.locator('[name=username]').fill('rover_qa');await page.locator('[name=password]').fill('rover-test-123');await page.locator('button[value=register]').click();
 await page.locator('.ready-button:not([disabled])').waitFor();await page.locator('.ready-button').click();await page.waitForFunction(()=>window.qa.state?.stage==='running',null,{timeout:45000});
 await page.locator('.player-lobby').waitFor({state:'hidden'});await page.getByRole('button',{name:'Блокнот / роверы'}).click();await page.locator('dialog.rover-panel[open]').waitFor();
 await page.screenshot({path:path.join(out,'terminal-desktop.png')});
 await page.locator('[data-survey]').click();await page.waitForFunction(()=>window.qa.state?.rover_surveys?.length>0);
 const state=await page.evaluate(()=>window.qa.state);
 // Survey is recorded through the notebook; registration is typed into the office UI.
 const point=state.rover_surveys[0];
 assert.ok(state.office_access,'start position must reach office');
 const rejected=await page.evaluate(()=>window.marsClient.command('rover.point.register',{name:'UNVISITED',latitude:0,longitude:0}));
 await page.waitForFunction(id=>!!window.qa.results[id],rejected);
 assert.equal((await page.evaluate(id=>window.qa.results[id],rejected)).code,'SURVEY_REQUIRED');
 await page.locator('[data-name]').fill('START');await page.locator('[data-lat]').fill(String(point.latitude));await page.locator('[data-lon]').fill(String(point.longitude));await page.locator('[data-register]').click();
 await page.waitForFunction(()=>window.qa.state?.rover_points?.some(p=>p.name==='START'));
 await page.locator('[data-program]').fill('invalid()');await page.locator('[data-save]').click();
 await page.locator('[data-feedback]').filter({hasText:/строк|программ|команд/i}).waitFor();
 await page.locator('[data-program]').fill('move_to(START)\nwait(1)');await page.locator('[data-save]').click();
 await page.waitForFunction(()=>window.qa.state?.rover_fleet?.[0]?.program==='move_to(START)\nwait(1)');
 await page.locator('[data-run]').click();await page.waitForFunction(()=>window.qa.state?.rover_fleet?.[0]?.status==='running');
 await page.waitForFunction(()=>window.qa.state?.rover_fleet?.[0]?.status==='idle',null,{timeout:15000});
 fs.writeFileSync(path.join(out,'snapshot.json'),JSON.stringify(state,null,2));
 assert.equal(state.rover_fleet.length,1,'one initial rover');assert.ok(state.buildings.some(b=>b.building_type==='office'||b.building_type==='dome_base'),'starting office');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.querySelector('.rover-panel').scrollWidth<=document.querySelector('.rover-panel').clientWidth+1),'mobile terminal must not overflow horizontally');await page.screenshot({path:path.join(out,'terminal-mobile.png')});
 await page.locator('.rover-panel [data-close]').click();assert.equal(await page.locator('dialog.rover-panel[open]').count(),0);
 // Closing the overlay must restore keyboard input; observe the real outgoing input protocol.
 await page.evaluate(()=>{window.qa.sent=[];document.activeElement?.blur()});await page.keyboard.down('KeyW');
 try{await page.waitForFunction(()=>window.qa.sent.some(m=>m.type==='player.input'&&m.payload.move.some(n=>Math.abs(n)>.01)),null,{timeout:5000})}finally{await page.keyboard.up('KeyW')}
 await page.reload();await page.waitForFunction(()=>window.marsClient);await page.evaluate(()=>window.marsClient.events.on('world.state',s=>window.qa.state=s));await page.waitForFunction(()=>window.qa.state?.stage==='running');
 const after=await page.evaluate(()=>window.qa.state);assert.equal(after.rover_fleet.length,1,'reload must not duplicate rover');assert.ok(after.rover_surveys.length,'survey survives reconnect');assert.ok(after.rover_points.some(p=>p.name==='START'),'registry survives reconnect');
 assert.deepEqual(errors,[]);console.log('Browser smoke passed; fixture DB:',data);
 }catch(e){if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error(e);process.exitCode=1}finally{if(browser)await browser.close();child.kill()}})();

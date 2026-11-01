// Disposable browser smoke: own DATA_DIR and throwaway account only.
// Run after `npm --prefix client run build` with PLAYWRIGHT_MODULE set if needed.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {PNG}=require(process.env.PNGJS_MODULE||'pngjs');
const {spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/rover-review');
fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(out,'camera-db-'));
const port=Number(process.env.ROVER_PORT||18208),url=`http://127.0.0.1:${port}`;
const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const child=spawn(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(port)],{cwd:root,windowsHide:true,env:{...process.env,PYTHONPATH:path.join(root,'server'),DATA_DIR:data,STATIC_DIR:path.join(root,'client/dist'),MARS_ALLOWED_ORIGINS:url},stdio:['ignore','pipe','pipe']});
const log=fs.createWriteStream(path.join(out,'camera-server.log'));child.stdout.pipe(log);child.stderr.pipe(log);
async function ready(){for(let i=0;i<100;i++){try{if((await fetch(url+'/api/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,200))}throw Error('Server failed to start')}
function pixelDiversity(buffer){const png=PNG.sync.read(buffer),seen=new Set();let gold=0;for(let i=0;i<png.data.length;i+=4){const r=png.data[i],g=png.data[i+1],b=png.data[i+2];seen.add(`${r},${g},${b}`);if(r>230&&g>165&&g<235&&b>55&&b<155&&r-g>25&&g-b>25)gold++}return {width:png.width,height:png.height,colors:seen.size,goldPixels:gold};}
(async()=>{let browser,page;const errors=[];try{
 await ready();browser=await chromium.launch({channel:process.env.ROVER_BROWSER||'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   window.qa={state:null,previewDraws:0,results:{},sent:[]};
   const wrap=(proto,name)=>{if(!proto||!proto[name])return;const original=proto[name];proto[name]=function(...args){if(this.canvas?.matches?.('canvas[data-preview]'))window.qa.previewDraws++;return original.apply(this,args)}};
   for(const proto of [window.WebGLRenderingContext?.prototype,window.WebGL2RenderingContext?.prototype])for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'])wrap(proto,name);
   const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(...args){super(...args);this.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.type==='action.result')window.qa.results[m.request_id]=m.payload}catch{}})}send(data){try{window.qa.sent.push(JSON.parse(data))}catch{}return super.send(data)}};
 });
 await page.goto(url);await page.waitForFunction(()=>window.marsClient);await page.evaluate(()=>{window.marsClient.events.on('world.state',s=>window.qa.state=s);window.marsClient.events.on('camera.changed',mode=>window.qa.cameraMode=mode)});
 await page.locator('[name=username]').fill('camera_qa');await page.locator('[name=password]').fill('camera-test-123');await page.locator('button[value=register]').click();
 await page.locator('.ready-button:not([disabled])').waitFor();await page.locator('.ready-button').click();await page.waitForFunction(()=>window.qa.state?.stage==='running',null,{timeout:45000});
 await page.locator('.player-lobby').waitFor({state:'hidden'});await page.getByRole('button',{name:'Блокнот / роверы'}).click();await page.locator('dialog.rover-panel[open]').waitFor();
 await page.waitForFunction(()=>window.qa.state?.rover_fleet?.length>0);
 const rover=await page.evaluate(()=>window.qa.state.rover_fleet[0]);
 assert.ok(rover.rover_id,'fleet has rover_id');assert.ok(Array.isArray(rover.position),'fleet position is a 3D vector');
 await page.waitForFunction(()=>document.querySelector('[data-no-signal]')?.hidden===true,null,{timeout:15000});
 const canvas=page.locator('canvas[data-preview]');await canvas.waitFor({state:'visible'});
 await page.waitForFunction(()=>window.qa.previewDraws>0,null,{timeout:15000});
 const cameraPath=path.join(out,'rover-camera.png');const cameraShot=await canvas.screenshot({path:cameraPath});
 const cameraPixels=pixelDiversity(cameraShot);assert.ok(cameraPixels.colors>8,`camera preview should contain rendered scene pixels, got ${cameraPixels.colors}`);
 assert.deepEqual(errors,[],'no browser page errors during camera rendering');
 await page.locator('[data-view="map"]').click();await page.waitForTimeout(500);
 const roverMapPath=path.join(out,'rover-map-selected-marker.png');const roverMapShot=await canvas.screenshot({path:roverMapPath});
 const roverMapPixels=pixelDiversity(roverMapShot);assert.ok(roverMapPixels.colors>8,'rover map canvas renders a scene');assert.ok(roverMapPixels.goldPixels>0,`rover map should render the gold selected-rover marker; got ${roverMapPixels.goldPixels} matching pixels`);
 await page.locator('.rover-panel [data-close]').click();await page.locator('dialog.rover-panel[open]').waitFor({state:'detached'});
 await page.evaluate(()=>{document.activeElement?.blur();window.marsClient.events.emit('camera.toggle')});
 await page.waitForFunction(()=>window.qa.cameraMode==='top',null,{timeout:5000});
 const mapCanvas=page.locator('main canvas').first();await mapCanvas.waitFor({state:'visible'});await page.waitForTimeout(400);
 const mapPath=path.join(out,'main-tab-map.png');const mapShot=await mapCanvas.screenshot({path:mapPath});
 const mapPixels=pixelDiversity(mapShot);assert.ok(mapPixels.colors>8,`main Tab map should render visible terrain, got ${mapPixels.colors}`);assert.ok(mapPixels.goldPixels>0,`main Tab map should retain the selected-rover marker after notebook close; got ${mapPixels.goldPixels} matching pixels`);
 assert.deepEqual(errors,[],'no browser page errors after returning to main map');
 console.log(JSON.stringify({ok:true,roverId:rover.rover_id,camera:cameraPixels,roverMap:roverMapPixels,previewDrawCalls:await page.evaluate(()=>window.qa.previewDraws),mainTabMap:mapPixels,cameraPath,roverMapPath,mapPath,errors},null,2));
 }catch(e){if(page)await page.screenshot({path:path.join(out,'camera-failure.png')}).catch(()=>{});console.error(e);process.exitCode=1}finally{if(browser)await browser.close();child.kill();log.end();const outPath=path.resolve(out),dataPath=path.resolve(data);if(dataPath.startsWith(outPath+path.sep)&&path.basename(dataPath).startsWith('camera-db-')){try{fs.rmSync(dataPath,{recursive:true,force:true})}catch{}}}
})();

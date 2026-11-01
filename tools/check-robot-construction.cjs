const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{const server=spawn(process.execPath,['client/node_modules/vite/bin/vite.js','client','--host','127.0.0.1','--port','15207','--strictPort'],{windowsHide:true,stdio:'ignore'});let browser;
try{
 for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:15207')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1200,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:15207/base-review.html');
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');const {WorldScene}=await import('/src/scene/world-scene.js');
  const host=document.createElement('div');host.style='position:fixed;inset:0;background:black';document.body.append(host);
  const world=new WorldScene(host,{on:()=>()=>{},emit:()=>{}});try{await world.models.loading;}catch(e){throw new Error(e.errors?.map(x=>x.message).join('; ')||e.message);}
  world.configure({self_id:'me',stage:'running',world:{radius:100,move_speed:4,view_radius:24,build_distance:6,shell:{radius:99.7,detail:1}},players:[{player_id:'me',position:[0,100,0]}],buildings:[{building_id:'plan',building_type:'wind_turbine',cell_id:'c',position:[3,99.955,0],construction_status:'planned'}]});
  // Simulate the already-loaded terrain cell, then exercise the real frame hooks.
  const tile=new T.Mesh(new T.BoxGeometry(.01,.01,.01),new T.MeshBasicMaterial());tile.userData.cell={cell_id:'c',center:[3,99.955,0]};
  tile.userData.outline=new T.Group();world.chunks.set('qa',{cells:[tile],group:new T.Group()});world.mode='top';world.frame(performance.now()+16);
  const entry=world.buildings.get('plan');const plan=entry.mesh.userData.constructionPlan;
  const builders=[...world.robots.entries.values()].filter(e=>e.role.role==='builder').length;
  const loaded=['solar_panel','wind_turbine','robot_minion'].every(n=>world.models.assets.has(n));
  for(let i=0;i<160;i++)world.robots.update(.05);
  world.applyState({buildings:[{...entry.data,construction_status:'building'}]});world.frame(performance.now()+32);
  world.applyState({buildings:[{...entry.data,construction_status:'completed'}]});world.frame(performance.now()+48);
  const completed=!entry.mesh.userData.constructionPlan;const spin=entry.mesh.userData.animation?.current;
  window.robotSmokeWorld=world;
  return {loaded,plan,builders,completed,spin};
 });
 assert.deepEqual(result,{loaded:true,plan:true,builders:3,completed:true,spin:'spin'});assert.deepEqual(errors,[]);
 fs.mkdirSync('artifacts/robot-construction',{recursive:true});await page.screenshot({path:'artifacts/robot-construction/smoke.png'});console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1});

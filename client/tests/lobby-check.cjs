// Run against a fresh server/database; this exercises real HTTP and WebSocket traffic.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');fs.mkdirSync('client/test-results',{recursive:true});
const base=process.env.LOBBY_BASE_URL||'http://localhost:8011';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const errors=[];const contexts=[];const pages=[];const ids=[];
 try{
  for(let i=0;i<4;i++){
   const context=await browser.newContext({viewport:{width:1200,height:900}});
   contexts.push(context);
   const username=['alex','masha','ivan','dasha'][i];
   const response=await context.request.post(base+'/api/auth/register',{headers:{origin:base},data:{username,password:'lobby-test-password'}});
   assert.equal(response.status(),201);ids.push((await response.json()).user_id);
   // Verify the visible login form for the first player.
   if(i===0)await context.request.post(base+'/api/auth/logout',{headers:{origin:base}});
   const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);
   if(i===0){
    await page.locator('#auth:not([hidden])').waitFor();
    await page.locator('[name=username]').fill(username);
    await page.locator('[name=password]').fill('lobby-test-password');
    await page.getByRole('button',{name:'Войти',exact:true}).click();
   }
   await page.locator('.player-lobby[open]').waitFor();
   await page.waitForFunction(()=>!document.querySelector('.ready-button').disabled);
   assert.equal(await page.locator('.pilot-name').innerText(),username);
  }
  const [a,b,c,d]=pages;
  for(const page of pages)await page.waitForFunction(()=>document.querySelectorAll('.player-row').length===4);
  const avatars=await a.locator('.player-row img').evaluateAll(images=>images.map(img=>img.src));
  assert.equal(new Set(avatars).size,4);
  await a.getByRole('button',{name:'Готов',exact:true}).click();
  await b.waitForFunction(()=>document.querySelectorAll('.ready-status.is-ready').length===1);
  await a.getByRole('button',{name:'Отменить готовность'}).click();
  await b.waitForFunction(()=>document.querySelectorAll('.ready-status.is-ready').length===0);
  await a.getByRole('button',{name:'Настройки профиля',exact:true}).click();
  await a.getByRole('button',{name:'Другой вариант',exact:true}).click();
  await a.getByRole('button',{name:'Цвет 2',exact:true}).click();
  const avatar=await a.locator('.avatar-editor img').getAttribute('src');
  await a.screenshot({path:'client/test-results/profile.png'});
  await a.getByRole('button',{name:'Сохранить',exact:true}).click();
  await b.waitForFunction(({id,avatar})=>document.querySelector('[data-user-id="'+id+'"] img')?.src===avatar,{id:ids[0],avatar});
  // Reload keeps appearance but does not replay readiness.
  await a.getByRole('button',{name:'Готов',exact:true}).click();
  await b.waitForFunction(()=>document.querySelectorAll('.ready-status.is-ready').length===1);
  await a.reload();await a.locator('.player-lobby[open]').waitFor();
  await a.waitForFunction(()=>!document.querySelector('.ready-button').disabled);
  assert.equal(await a.locator('.pilot-avatar').getAttribute('src'),avatar);
  await b.waitForFunction(()=>document.querySelectorAll('.player-row').length===4&&document.querySelectorAll('.ready-status.is-ready').length===0);
  for(const page of [a,b,d])await page.getByRole('button',{name:'Готов',exact:true}).click();
  await c.waitForFunction(()=>document.querySelectorAll('.ready-status.is-ready').length===3);
  await c.keyboard.press('Escape');
  assert.equal(await c.locator('.player-lobby').getAttribute('open'),'');
  assert.equal(await c.locator('.lobby-close').isVisible(),false);
  assert.equal(await c.locator('.mission-facts,.mission-route,.lobby-telemetry').count(),0);
  await c.screenshot({path:'client/test-results/lobby.png'});
  await d.setViewportSize({width:390,height:844});
  assert.ok(await d.evaluate(()=>document.querySelector('.player-lobby').scrollWidth<=window.innerWidth));
  await d.screenshot({path:'client/test-results/lobby-mobile.png'});
  await c.getByRole('button',{name:'Готов',exact:true}).click();
  for(const page of pages)await page.locator('.player-lobby:not([open])').waitFor({state:'attached'});
  await a.getByRole('button',{name:'Открыть список игроков'}).click();
  await a.getByRole('button',{name:'Вернуться в игру'}).click();
  await a.locator('.player-lobby:not([open])').waitFor({state:'attached'});
  await d.getByRole('button',{name:'Открыть список игроков'}).click();
  await d.getByRole('button',{name:'Выйти из аккаунта'}).click();
  await d.locator('#auth:not([hidden])').waitFor();
  await a.getByRole('button',{name:'Открыть список игроков'}).click();
  await a.waitForFunction(()=>document.querySelectorAll('.player-row').length===3);
  assert.deepEqual(errors,[]);
  console.log('PASS: real login, four-player roster, unique/shared avatars, cancel ready, reconnect, unanimous start, mobile layout and logout');
 }finally{
  for(const context of contexts)await context.close();
  await browser.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});

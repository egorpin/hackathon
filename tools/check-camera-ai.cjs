const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
  fs.mkdirSync('client/test-results',{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    await page.addInitScript(()=>{
      window.speechCheck={spoken:[],cancelled:0,utterance:null};
      window.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{
        getVoices:()=>[{lang:'ru-RU',localService:true}],
        speak(utterance){window.speechCheck.spoken.push(utterance.text);window.speechCheck.utterance=utterance;},
        cancel(){window.speechCheck.cancelled++;},
      }});
    });
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/agent/messages',route=>route.fulfill({json:{messages:[]}}));
    await page.route('**/api/agent/ask',async route=>{
      await new Promise(resolve=>setTimeout(resolve,300));
      await route.fulfill({json:{text:'**Бур** ставится рядом с игроком.\n\n- Найди ресурс\n- Нажми `B`\n\n```python\nprint("Марс")\n```\n\n[Справка](https://example.com)\n\n<script>alert(1)</script>\n[Опасная ссылка](javascript:alert(1))'}});
    });
    await page.goto('http://localhost:8000/?fixture');
    await page.waitForFunction(()=>!!window.marsClient);
    await page.locator('.lobby-close').click();
    await page.waitForTimeout(700);
    await page.keyboard.press('Tab');await page.waitForTimeout(500);
    await page.screenshot({path:'client/test-results/camera-top.png'});
    await page.mouse.move(850,440);await page.mouse.wheel(0,1400);await page.waitForTimeout(500);
    await page.screenshot({path:'client/test-results/camera-zoom.png'});
    await page.mouse.down();await page.mouse.move(1100,620,{steps:15});await page.mouse.up();
    await page.waitForTimeout(500);await page.screenshot({path:'client/test-results/camera-orbit.png'});
    await page.keyboard.press('Tab');await page.waitForTimeout(300);
    assert.match(await page.locator('#mode').innerText(),/первое лицо/);
    await page.getByRole('button',{name:'ИИ-помощник',exact:true}).click();
    const panel=page.locator('aside.assistant');
    const boxDesktop=await panel.boundingBox();assert.ok(boxDesktop.x>900);
    assert.equal(await page.locator('dialog[open]').count(),0);
    await page.locator('#viewport canvas').focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Твой вопрос',{exact:true}).fill('Где строить бур?');
    await page.keyboard.press('Shift+Enter');
    assert.match(await page.getByLabel('Твой вопрос',{exact:true}).inputValue(),/\n$/);
    await page.keyboard.type('Подскажи');await page.keyboard.press('Enter');
    assert.equal(await page.getByLabel('Твой вопрос',{exact:true}).evaluate(el=>el===document.activeElement),false);
    // Gameplay remains available while the panel is open and the model responds.
    await page.keyboard.press('Tab');assert.match(await page.locator('#mode').innerText(),/Обзор планеты/);
    await page.getByRole('log').locator('.assistant-markdown strong').waitFor();
    assert.equal(await page.locator('.assistant-message').count(),2);
    assert.equal(await page.locator('.assistant script').count(),0);
    assert.equal(await page.locator('.assistant-markdown pre code').innerText(),'print("Марс")\n');
    assert.equal(await page.locator('.assistant-markdown li').count(),2);
    assert.equal(await page.locator('.assistant a[href^="javascript:"]').count(),0);
    const replyBox=await page.locator('.assistant-message.reply').boundingBox();
    const logBox=await page.getByRole('log').boundingBox();
    assert.ok(replyBox.x>=logBox.x && replyBox.y+replyBox.height<=logBox.y+logBox.height+1);
    assert.equal(await page.getByLabel('Твой вопрос',{exact:true}).evaluate(el=>el===document.activeElement),false);
    const read=page.getByRole('button',{name:'Озвучить',exact:true}), stop=page.getByRole('button',{name:'Стоп',exact:true});
    assert.equal(await stop.isDisabled(),true);
    await read.click();assert.equal(await stop.isDisabled(),false);assert.equal(await read.isDisabled(),true);
    assert.match(await page.evaluate(()=>window.speechCheck.spoken[0]),/Бур/);
    assert.doesNotMatch(await page.evaluate(()=>window.speechCheck.spoken[0]),/\*\*|<script>/);
    await stop.click();assert.equal(await stop.isDisabled(),true);assert.equal(await read.isDisabled(),false);
    assert.equal(await page.evaluate(()=>window.speechCheck.cancelled),1);
    await read.click();await page.evaluate(()=>{for(let i=0;i<30;i++){const current=window.speechCheck.utterance;current.onend();if(window.speechCheck.utterance===current)break;}});
    assert.equal(await read.isDisabled(),false);assert.equal(await stop.isDisabled(),true);
    assert.equal(await page.locator('.assistant-intro,.assistant-heading .eyebrow').count(),0);
    await page.screenshot({path:'client/test-results/assistant.png'});
    await page.locator('#viewport canvas').focus();
    await page.keyboard.press('Enter');assert.equal(await page.getByLabel('Твой вопрос',{exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Enter');assert.equal(await page.getByLabel('Твой вопрос',{exact:true}).evaluate(el=>el===document.activeElement),false);
    await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'ИИ-помощник',exact:true}).click();
    await page.screenshot({path:'client/test-results/assistant-mobile.png'});
    const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
    assert.deepEqual(errors,[]);console.log('PASS: camera, right sidebar, Enter typing/send/resume, Shift+Enter, Markdown and sanitized HTML, mobile; no JS errors');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});

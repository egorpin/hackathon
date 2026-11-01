const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');

(async()=>{
  const output='client/test-results/agent-activity';fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.speechCheck={spoken:[],cancelled:0,utterance:null};
      window.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{
        getVoices:()=>[{lang:'ru-RU',localService:true}],
        speak(utterance){window.speechCheck.spoken.push(utterance.text);window.speechCheck.utterance=utterance;utterance.onstart?.();},
        cancel(){window.speechCheck.cancelled++;},
      }});
    });
    await page.route('**/api/agent/messages',route=>route.fulfill({json:{messages:[]}}));
    await page.route('**/api/agent/ask',route=>new Promise(resolve=>{
      requests.push(async response=>{await route.fulfill(response);resolve();});
    }));
    await page.goto((process.env.MARS_TEST_URL || 'http://127.0.0.1:5175')+'/?fixture');
    await page.waitForFunction(()=>!!window.marsClient);
    await page.locator('.lobby-close').click();
    await page.locator('.player-lobby').waitFor({state:'hidden'});
    const toggle=page.getByRole('button',{name:'ИИ-помощник',exact:true});
    const activity=page.locator('.assistant-activity'),mini=page.locator('.assistant-button-activity');
    const input=page.getByLabel('Твой вопрос',{exact:true});
    const screenshot=name=>page.screenshot({path:`${output}/${name}.png`});
    const state=async name=>{
      await page.locator(`.assistant-activity[data-state="${name}"]:not([hidden])`).waitFor();
      assert.equal(await mini.isVisible(),true);
    };
    const idle=async()=>{
      await activity.waitFor({state:'hidden'});await mini.waitFor({state:'hidden'});
    };
    const ask=async text=>{
      await input.fill(text);await page.locator('.assistant button[type=submit]').click();
      await state('thinking');
    };
    const reply=async()=>{
      assert.ok(requests.length,'request reached mocked endpoint');
      await requests.shift()({json:{text:'**Бур** добывает ресурсы. Выбери жилу, затем кликни по ней левой кнопкой мыши.\n\n- Найди железо\n- Поставь бур'}});
    };
    await toggle.click();await page.locator('.assistant button[type=submit]').waitFor();
    await idle();
    await ask('Где поставить бур?');
    await screenshot('desktop-thinking');
    await page.locator('.assistant-close').click();
    assert.equal(await page.locator('#assistant-panel').isVisible(),false);
    assert.equal(await mini.isVisible(),true);
    await screenshot('desktop-collapsed-thinking');
    await toggle.click();await state('thinking');
    await reply();await state('writing');
    await screenshot('desktop-writing');
    await idle();
    assert.equal(await page.locator('.assistant-message.reply').count(),1);
    const speak=page.getByRole('button',{name:'Озвучить',exact:true}).last();
    const stop=page.getByRole('button',{name:'Стоп',exact:true}).last();
    await speak.click();await state('speaking');await screenshot('desktop-speaking');
    await stop.click();await idle();
    assert.equal(await speak.isDisabled(),false);
    await speak.click();await state('speaking');
    await page.evaluate(()=>{
      for(let i=0;i<30;i++){
        const utterance=window.speechCheck.utterance;utterance.onend?.();
        if(window.speechCheck.utterance===utterance)break;
      }
    });
    await idle();
    await speak.click();await state('speaking');
    await page.evaluate(()=>window.speechCheck.utterance.onerror?.({error:'synthesis-failed'}));
    await idle();
    await ask('Проверка ошибки');
    await requests.shift()({status:503,json:{detail:'Модель временно недоступна.'}});
    await idle();assert.match(await page.locator('.assistant-status').innerText(),/Модель временно недоступна/);
    assert.equal(await input.inputValue(),'Проверка ошибки');
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({reducedMotion:'reduce'});
    await ask('Как добыть железо?');await screenshot('mobile-thinking');
    const box=await page.locator('#assistant-panel').boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=390);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await reply();await idle();
    await page.getByRole('button',{name:'Озвучить',exact:true}).last().click();await state('speaking');
    await screenshot('mobile-speaking');
    await page.locator('.assistant-close').click();await idle();
    assert.deepEqual(errors,[]);
    console.log('PASS: thinking/writing/speaking, collapsed header activity, speech stop/end/error, request error, reduced motion, desktop/mobile; no JS errors.');
    console.log('Screenshots: '+output);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});

// Run against a fresh disposable world: this test creates a player and starts it.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  let page;
  try {
    page = await browser.newPage({viewport:{width:1365,height:900}});
    page.setDefaultTimeout(15000);
    const errors=[];
    page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
    await page.goto(process.env.MARS_TEST_URL || 'http://localhost:18000/');
    await page.locator('#auth:not([hidden])').waitFor();
    await page.locator('[name=username]').fill('browser_' + Date.now());
    await page.locator('[name=password]').fill('browser-test-password');
    await page.getByRole('button',{name:'Создать игрока'}).click();
    await page.waitForFunction(()=>/Чанки: [1-9]/.test(document.querySelector('#cache').textContent));
    await page.waitForFunction(()=>/вызовы отрисовки: [1-9]/.test(document.querySelector('#performance').textContent));
    assert.equal(await page.locator('#connection').innerText(),'Подключено');
    await page.getByRole('button',{name:'Начать экспедицию'}).click();
    await page.locator('#start').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Сменить камеру'}).click();
    await page.waitForTimeout(500);
    if (process.env.MARS_SCREENSHOT) await page.screenshot({path:process.env.MARS_SCREENSHOT});
    await page.reload();
    await page.waitForFunction(()=>/Чанки: [1-9]/.test(document.querySelector('#cache').textContent));
    assert.equal(await page.locator('#connection').innerText(),'Подключено');
    assert.deepEqual(errors,[]);
    assert.ok(!(await page.locator('#notice').innerText()).includes('[object Object]'));
    console.log(JSON.stringify({status:'PASS',cache:await page.locator('#cache').innerText(),errors}));
  } catch (error) {
    if (page) {
      console.error(await page.locator('body').innerText());
      if (process.env.MARS_SCREENSHOT) await page.screenshot({path:process.env.MARS_SCREENSHOT});
    }
    throw error;
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});

const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const fs=require('fs');const path=require('path');const {pathToFileURL}=require('url');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--allow-file-access-from-files']});
try{const page=await browser.newPage({viewport:{width:1400,height:900}});page.on('pageerror',e=>console.error(e));
await page.goto(pathToFileURL(path.resolve('artifacts/simple-model-preview/animated.html')).href);
await page.waitForFunction(()=>window.ready);
const assets=await page.evaluate(()=>window.exports);
for(const [name,bytes] of Object.entries(assets)){fs.writeFileSync('assets/models/energy-v2/'+name+(name==='solar-panel'?'-textured.glb':'-textured-animated.glb'),Buffer.from(bytes));console.log(name,bytes.length,'bytes');}
const atlas=await page.evaluate(()=>window.atlasPNG);fs.writeFileSync('assets/models/energy-v2/painted-metal-atlas.png',Buffer.from(atlas.split(',')[1],'base64'));
await page.screenshot({path:'artifacts/simple-model-preview/animated-preview.png'});
await page.locator('#walk').click();await page.screenshot({path:'artifacts/simple-model-preview/walk-preview.png'});
console.log(JSON.stringify(await page.evaluate(()=>window.clipReport)));
for(const name of ['build','wave','jump']){await page.evaluate(n=>window.selectRobotClip(n,n==='jump'?.65:.65),name);await page.screenshot({path:'artifacts/simple-model-preview/'+name+'-preview.png'});}
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});

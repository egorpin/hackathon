const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto('file:///D:/%D1%81%D0%BC%D0%B5%D1%88%D0%BD%D1%8F%D0%B2%D0%BA%D0%B8/%D1%85%D0%B0%D0%BA%D0%B0%D1%82%D0%BE%D0%BD/artifacts/simple-model-preview/index.html', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'artifacts/simple-model-preview/models-preview.png' });
  await browser.close();
})();

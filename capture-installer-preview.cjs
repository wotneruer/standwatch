const { chromium } = require('../node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('console', message => console.log('browser:', message.type(), message.text()));
  page.on('pageerror', error => console.error('page:', error.message));
  await page.goto('http://127.0.0.1:8820/?preview=plan&server=Poruch%20QA', {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction(() => document.getElementById('planDlg') && !document.getElementById('planDlg').hidden, null, { timeout: 15000 });
  await page.waitForTimeout(4000);
  await page.click('#p_detect_root');
  await page.waitForFunction(() => !document.getElementById('p_detect_root').disabled, null, { timeout: 15000 });
  console.log(await page.evaluate(() => ({
    current: typeof current === 'undefined' ? null : current,
    rows: typeof lastRows === 'undefined' ? null : lastRows.length,
    panelVisible: !document.getElementById('planDlg')?.hidden,
    projectFromUrl: normalizeInstallerProject('https://gitlab.example.com/vpo/installer/-/tree/dev'),
    fingerprintVisible: document.body.innerText.includes('Технічний відбиток'),
    installRoot: document.getElementById('p_install_root').value,
    installRootHint: document.getElementById('p_install_root_hint').innerText,
    body: document.body.innerText.slice(0, 500),
  })));
  await page.screenshot({ path: 'installer-plan-preview.png', fullPage: true });
  await page.click('#projectsbtn');
  await page.waitForTimeout(300);
  await page.click('#pm_server_summary');
  await page.screenshot({ path: 'installer-catalog-preview.png', fullPage: true });
  await page.mouse.click(10, 180);
  if (await page.evaluate(() => document.getElementById('projectDlg').open)) throw new Error('Backdrop click did not close project dialog');
  await page.evaluate(() => closePlan());
  await page.click('#srv .add');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'add-server-project-preview.png', fullPage: true });
  await browser.close();
})();

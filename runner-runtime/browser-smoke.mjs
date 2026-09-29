import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/orlynx/playwright/node_modules/playwright');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Orlynx browser smoke</title><main>ready</main>');
  const title = await page.title();
  const main = await page.locator('main').textContent();
  if (title !== 'Orlynx browser smoke' || main !== 'ready') {
    throw new Error(`Unexpected browser smoke result title=${title} main=${main}`);
  }
  console.log('Orlynx browser runtime ready: Chromium launched successfully.');
} finally {
  await browser.close();
}

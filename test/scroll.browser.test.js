const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { /* optional browser tests */ }

test('image-heavy document retains scroll position across repeated refreshes',
    { skip: !chromium && 'Install Playwright to run browser regression tests' }, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-view-scroll-'));
        const documentPath = 'notes/images.md';
        const storageKey = 'markdown-view.tabs.v1';
        const target = 1600;
        const image = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"></svg>';
        await fs.mkdir(path.join(root, 'notes', 'images'), { recursive: true });
        await fs.writeFile(path.join(root, documentPath),
            Array.from({ length: 14 }, (_, index) => '![Image](images/' + index + '.svg)').join(String.fromCharCode(10, 10)));
        await Promise.all(Array.from({ length: 14 }, (_, index) =>
            fs.writeFile(path.join(root, 'notes', 'images', index + '.svg'), image)));

        const server = createApp(root).listen(0, '127.0.0.1');
        await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
        let browser;
        t.after(async () => {
            if (browser) await browser.close();
            await new Promise(resolve => server.close(resolve));
            await fs.rm(root, { recursive: true, force: true });
        });
        browser = await chromium.launch({
            headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        });
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await page.addInitScript(({ documentPath, storageKey, target }) => {
            if (!localStorage.getItem(storageKey)) {
                localStorage.setItem(storageKey, JSON.stringify({
                    activePath: documentPath, tabs: [{ path: documentPath, scrollTop: target }]
                }));
            }
        }, { documentPath, storageKey, target });
        await page.route('**/assets/**', async route => {
            await new Promise(resolve => setTimeout(resolve, 700));
            await route.continue();
        });
        const storedTop = () => page.evaluate(key =>
            JSON.parse(localStorage.getItem(key)).tabs[0].scrollTop, storageKey);
        const url = 'http://127.0.0.1:' + server.address().port + '/#' + encodeURIComponent(documentPath);

        for (let refresh = 0; refresh < 4; refresh++) {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.querySelectorAll('#markdown-content img').length === 14);
            await page.waitForTimeout(200);
            assert.equal(await storedTop(), target, 'refresh ' + refresh + ': image loading overwrote saved position');
            await page.waitForFunction(() => [...document.querySelectorAll('#markdown-content img')].every(image => image.complete));
            await page.waitForFunction(expected => document.querySelector('.content').scrollTop === expected, target);
            assert.equal(await storedTop(), target, 'refresh ' + refresh + ': restored position was not retained');
        }
    });

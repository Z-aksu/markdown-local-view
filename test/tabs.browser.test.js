const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

// Use an existing Playwright installation; the application has no browser dependency.
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { /* optional browser tests */ }

test('open tab dropdown in a real browser', { skip: !chromium && 'Install Playwright to run browser regression tests' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-view-tabs-'));
    const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'one/同名文档.md', 'two/同名文档.md',
        ...Array.from({ length: 14 }, (_, index) => `文档/第${index + 1}章-一个用于验证完整显示的较长文件名.md`)];
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    const server = createApp(root).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const url = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    for (const file of paths) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), `# ${file}\n\n${'阅读内容。\n\n'.repeat(100)}`);
    }
    const errors = [];
    const makePage = async (opened = [], width = 390, mobile = true) => {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile });
        t.after(() => context.close());
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ opened }) => {
            localStorage.setItem('markdown-view.tabs.v1', JSON.stringify({
                tabs: opened.map(path => ({ path, scrollTop: 0 })), activePath: opened.at(-1) || null
            }));
        }, { opened });
        await page.goto(url);
        await page.waitForFunction(count => document.querySelectorAll('#tabs .tab').length === count, opened.length);
        if (opened.length) await page.locator('#markdown-content h1').waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return page;
    };
    const checkActiveVisible = page => page.evaluate(() => {
        const container = document.getElementById('tabs').getBoundingClientRect();
        const active = document.querySelector('#tabs .tab.active').getBoundingClientRect();
        return active.left >= container.left - 1 && active.right <= container.right + 1;
    });

    await t.test('empty and short tab strips do not display the control', async () => {
        for (const opened of [[], paths.slice(0, 1), paths.slice(0, 2)]) {
            const page = await makePage(opened);
            assert.equal(await page.locator('#tabs-overflow-toggle').isVisible(), false);
        }
    });

    await t.test('many mobile tabs show every title and path, then switch to a hidden tab', async () => {
        const page = await makePage(paths);
        assert.equal(await page.locator('#tabs-overflow-toggle').isVisible(), true);
        assert.equal(await checkActiveVisible(page), true);
        await page.locator('#tabs-overflow-toggle').tap();
        assert.equal(await page.locator('.tabs-overflow-item').count(), paths.length);
        assert.equal(await page.locator('#tabs-overflow-count').textContent(), String(paths.length));
        assert.deepEqual(await page.locator('.tabs-overflow-title').allTextContents(), paths.map(file => file.split('/').at(-1)));
        assert.equal(await page.locator('.tabs-overflow-item[aria-current=page]').getAttribute('data-path'), paths.at(-1));
        assert.equal(await page.locator('.tabs-overflow-path').filter({ hasText: 'one/同名文档.md' }).count(), 1);
        assert.equal(await page.locator('.tabs-overflow-path').filter({ hasText: 'two/同名文档.md' }).count(), 1);
        const bounds = await page.locator('#tabs-overflow-panel').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        assert.equal(await page.locator('.tabs-overflow-list').evaluate(list => list.scrollHeight > list.clientHeight), true);
        if (process.env.MARKDOWN_VIEW_SCREENSHOTS) {
            await fs.mkdir(process.env.MARKDOWN_VIEW_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.MARKDOWN_VIEW_SCREENSHOTS, 'mobile-tabs-dropdown.png') });
        }
        await page.locator('.tabs-overflow-item').first().tap();
        await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.dataset.path === 'a.md');
        await page.waitForFunction(() => {
            const container = document.getElementById('tabs').getBoundingClientRect();
            const active = document.querySelector('#tabs .tab.active').getBoundingClientRect();
            return active.left >= container.left - 1 && active.right <= container.right + 1;
        });
        assert.equal(await page.locator('#tabs-overflow-panel').isVisible(), false);
        assert.equal(await page.locator('#tabs-overflow-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await checkActiveVisible(page), true);
        await page.locator('#tabs-overflow-toggle').tap();
        assert.equal(await page.locator('.tabs-overflow-item[aria-current=page]').getAttribute('data-path'), paths[0]);
        if (process.env.MARKDOWN_VIEW_SCREENSHOTS) {
            await page.screenshot({ path: path.join(process.env.MARKDOWN_VIEW_SCREENSHOTS, 'mobile-tabs-dropdown-first.png') });
        }
    });

    await t.test('toggle, outside tap, Escape and keyboard navigation close or switch correctly', async () => {
        const page = await makePage(paths);
        const toggle = page.locator('#tabs-overflow-toggle');
        const panel = page.locator('#tabs-overflow-panel');
        await toggle.tap();
        await toggle.tap();
        assert.equal(await panel.isVisible(), false);
        await toggle.tap();
        await page.touchscreen.tap(10, 600);
        assert.equal(await panel.isVisible(), false);
        await toggle.focus();
        await page.keyboard.press('ArrowDown');
        assert.equal(await panel.isVisible(), true);
        await page.keyboard.press('Home');
        assert.equal(await page.locator('.tabs-overflow-item').first().evaluate(button => button === document.activeElement), true);
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.locator('.tabs-overflow-item').last().evaluate(button => button === document.activeElement), true);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.dataset.path === 'b.md');
        assert.equal(await panel.isVisible(), false);
        await toggle.tap();
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        assert.equal(await toggle.evaluate(button => button === document.activeElement), true);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Tab');
        // Tabbing within the list keeps it open; leaving the last item closes it.
        assert.equal(await panel.isVisible(), true);
        await page.keyboard.press('End');
        await page.keyboard.press('Tab');
        assert.equal(await panel.isVisible(), false);
    });

    await t.test('the control disappears as soon as tabs fit, including its own reserved width', async () => {
        const page = await makePage(paths.slice(0, 3));
        await page.locator('#tabs-overflow-toggle').tap();
        await page.setViewportSize({ width: 480, height: 844 });
        await page.locator('#tabs-overflow').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#tabs-overflow-panel').isVisible(), false);
        await page.setViewportSize({ width: 320, height: 844 });
        await page.locator('#tabs-overflow-toggle').waitFor({ state: 'visible' });
        const toolbar = await page.locator('.content-toolbar').boundingBox();
        const toggle = await page.locator('#tabs-overflow-toggle').boundingBox();
        assert.ok(toggle.x + toggle.width <= toolbar.x + toolbar.width + 1);
        await page.locator('#tabs .tab.active .tab-close').tap();
        await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#tabs-overflow').waitFor({ state: 'hidden' });
        await page.locator('#tabs .tab.active .tab-close').tap();
        await page.locator('#tabs .tab.active .tab-close').tap();
        await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 0);
        assert.equal(await page.locator('#tabs-overflow-toggle').isVisible(), false);
    });

    await t.test('desktop sidebar resizing and collapse recalculate overflow', async () => {
        const page = await makePage(paths.slice(0, 4), 900, false);
        assert.equal(await page.locator('#tabs-overflow-toggle').isVisible(), false);
        await page.locator('#drag-resizer').hover();
        await page.mouse.down();
        await page.mouse.move(450, 300);
        await page.mouse.up();
        await page.locator('#tabs-overflow-toggle').waitFor({ state: 'visible' });
        await page.locator('#sidebar-toggle').click();
        await page.locator('#tabs-overflow').waitFor({ state: 'hidden' });
    });

    await t.test('manual horizontal scrolling still works and opening the list preserves reading position', async () => {
        const page = await makePage(paths);
        await page.locator('#tabs').evaluate(tabs => { tabs.scrollLeft = 0; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#tabs').evaluate(tabs => tabs.scrollLeft), 0);
        await page.locator('.content').evaluate(content => { content.scrollTop = 500; });
        await page.waitForFunction(() => document.querySelector('.content').scrollTop === 500);
        await page.locator('#tabs-overflow-toggle').tap();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.content').evaluate(content => content.scrollTop), 500);
    });

    await t.test('titles are rendered as text, not markup', async () => {
        const page = await makePage(paths);
        await page.evaluate(() => {
            tabs.get('a.md').title = '<img src=x onerror=alert(1)>';
            renderTabs();
        });
        await page.locator('#tabs-overflow-toggle').tap();
        assert.equal(await page.locator('.tabs-overflow-title').first().textContent(), '<img src=x onerror=alert(1)>');
        assert.equal(await page.locator('#tabs-overflow-list img').count(), 0);
    });

    assert.deepEqual(errors, [], 'no uncaught browser errors');
});

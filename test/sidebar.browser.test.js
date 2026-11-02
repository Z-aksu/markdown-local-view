const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../src/server');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { /* optional browser tests */ }

test('sidebar layout before the application script loads', { skip: !chromium && 'Install Playwright to run browser regression tests' }, async t => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    const server = createApp(path.join(__dirname, '../test_docs')).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const url = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    });
    const errors = [];
    const makePage = async (subtest, mobile, saved = null, storageDenied = false) => {
        const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
        subtest.after(() => context.close());
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ saved, storageDenied }) => {
            if (storageDenied) {
                Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
            } else if (saved !== null && localStorage.getItem('markdown-view.sidebar-collapsed.v1') === null) {
                localStorage.setItem('markdown-view.sidebar-collapsed.v1', saved);
            }
        }, { saved, storageDenied });
        return page;
    };
    const checkStartup = async (page, collapsed, mobile, reload = false) => {
        // Hold the main script so the first painted layout cannot rely on DOMContentLoaded.
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const blockScript = async route => { await gate; await route.continue(); };
        await page.route('**/script.js', blockScript);
        try {
            if (reload) await page.reload({ waitUntil: 'commit' });
            else await page.goto(url, { waitUntil: 'commit' });
            await page.locator('#sidebar').waitFor({ state: 'attached' });
            const frames = await page.evaluate(async () => {
                const samples = [];
                for (let i = 0; i < 3; i++) {
                    await new Promise(requestAnimationFrame);
                    const sidebar = document.getElementById('sidebar');
                    const bounds = sidebar.getBoundingClientRect();
                    samples.push({
                        collapsed: document.querySelector('.container').classList.contains('sidebar-collapsed'),
                        width: bounds.width, right: bounds.right, animations: sidebar.getAnimations().length,
                        readyState: document.readyState
                    });
                }
                return samples;
            });
            for (const frame of frames) {
                assert.equal(frame.readyState, 'loading', 'the main application has not initialized yet');
                assert.equal(frame.collapsed, collapsed);
                assert.equal(frame.animations, 0, 'restoring layout must not play a transition');
                if (collapsed) assert.ok(mobile ? frame.right <= 0 : frame.width === 0, 'the sidebar is already off screen');
                else assert.equal(frame.width, 292);
            }
        } finally {
            release();
        }
        await page.waitForLoadState('domcontentloaded');
        await page.unroute('**/script.js', blockScript);
        assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), String(!collapsed));
        assert.equal(await page.locator('#sidebar').evaluate(sidebar => sidebar.getAnimations().length), 0);
    };

    const cases = [
        { name: 'desktop remembers collapsed', mobile: false, saved: 'true', collapsed: true },
        { name: 'desktop remembers expanded', mobile: false, saved: 'false', collapsed: false },
        { name: 'desktop defaults to expanded', mobile: false, collapsed: false },
        { name: 'mobile starts collapsed with no saved setting', mobile: true, collapsed: true },
        { name: 'mobile starts collapsed with a saved expanded desktop setting', mobile: true, saved: 'false', collapsed: true },
        { name: 'mobile starts collapsed with a saved collapsed setting', mobile: true, saved: 'true', collapsed: true },
        { name: 'desktop tolerates unavailable storage', mobile: false, storageDenied: true, collapsed: false },
        { name: 'mobile tolerates unavailable storage', mobile: true, storageDenied: true, collapsed: true }
    ];
    for (const scenario of cases) {
        await t.test(scenario.name, async subtest => {
            const page = await makePage(subtest, scenario.mobile, scenario.saved, scenario.storageDenied);
            await checkStartup(page, scenario.collapsed, scenario.mobile);
        });
    }

    await t.test('manual toggles retain their animation and persist across reloads', async subtest => {
        const page = await makePage(subtest, false);
        await checkStartup(page, false, false);
        await page.locator('#sidebar-toggle').click();
        await page.waitForFunction(() => localStorage.getItem('markdown-view.sidebar-collapsed.v1') === 'true');
        assert.match(await page.locator('#sidebar').evaluate(sidebar => getComputedStyle(sidebar).transitionDuration), /0\.2s/);
        await checkStartup(page, true, false, true);
        await page.locator('#content-sidebar-toggle').click();
        await page.waitForFunction(() => localStorage.getItem('markdown-view.sidebar-collapsed.v1') === 'false');
        await checkStartup(page, false, false, true);
    });
    assert.deepEqual(errors, [], 'no uncaught browser errors');
});

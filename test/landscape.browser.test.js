const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { /* optional browser tests */ }

test('mobile landscape reading in a real browser', { skip: !chromium && 'Install Playwright to run browser regression tests' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-view-landscape-'));
    const guide = [
        '# Reading on the go', '',
        'Keep your notes close, wherever you work. Open a document and pick the view that feels comfortable.', '',
        '## A little more room', '',
        'Landscape reading gives tables, code, and equations more space while keeping your documents within reach.', '',
        '| Document | Updated | Status | Owner |', '| --- | --- | --- | --- |',
        '| Project notes | Today | Ready | Design |', '| API reference | Yesterday | In review | Engineering |', '',
        '```js', "const view = { reading: true, layout: 'landscape' };", '```', '',
        ...Array.from({ length: 100 }, (_, i) => `### Note ${i + 1}\n\nYour reading position stays with each document. Switch between notes, explore a table, or continue where you left off.\n`)
    ].join('\n');
    const files = ['other.md', 'guide.md', 'reference.md', 'notes.md', 'changelog.md'];
    await Promise.all(files.map(file => fs.writeFile(path.join(root, file), guide.replace('Reading on the go', file === 'guide.md' ? 'Reading on the go' : file))));
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    const server = createApp(root).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    t.after(async () => {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const makePage = async (subtest, { mode = 'missing', width = 390, height = 844, mobile = true, opened = files.slice(0, 2), storageDenied = false } = {}) => {
        const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
        subtest.after(() => context.close());
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ mode, opened, storageDenied }) => {
            if (storageDenied) {
                Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
            } else {
                localStorage.setItem('markdown-view.tabs.v1', JSON.stringify({ tabs: opened.map(path => ({ path, scrollTop: 0 })), activePath: opened.at(-1) }));
                localStorage.setItem('markdown-view.sidebar-collapsed.v1', 'false');
            }
            if (mode === 'native') return;
            const state = window.nativeState = { locks: [], unlocks: 0, requests: 0, exits: 0, locked: false, events: [] };
            let fullscreen = mode === 'external' ? true : null;
            Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen === true ? document.documentElement : fullscreen });
            Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: !['missing', 'no-fullscreen'].includes(mode) });
            const fullscreenChanged = () => document.dispatchEvent(new Event('fullscreenchange'));
            state.dismissFullscreen = () => { fullscreen = null; fullscreenChanged(); };
            Element.prototype.requestFullscreen = async options => {
                state.events.push('fullscreen');
                state.fullscreenOptions = options;
                state.requests++;
                if (mode === 'fullscreen-denied') throw new DOMException('Fullscreen was denied', 'NotAllowedError');
                if (mode === 'pending-fullscreen') await new Promise(resolve => { state.resolveFullscreen = resolve; });
                fullscreen = document.documentElement;
                fullscreenChanged();
            };
            document.exitFullscreen = async () => { state.exits++; fullscreen = null; fullscreenChanged(); };
            Object.defineProperty(screen.orientation, 'lock', {
                configurable: true,
                value: ['missing', 'missing-lock'].includes(mode) ? undefined : async direction => {
                    state.events.push('lock');
                    state.locks.push(direction);
                    if (['fullscreen', 'fullscreen-denied', 'lock-denied', 'pending-fullscreen'].includes(mode) && !fullscreen) {
                        throw new DOMException('Fullscreen is required', 'SecurityError');
                    }
                    if (mode === 'unsupported' || mode === 'lock-denied') throw new DOMException('Rotation is unavailable', 'NotSupportedError');
                    if (mode === 'pending-lock') await new Promise(resolve => { state.resolveLock = resolve; });
                    state.locked = true;
                }
            });
            Object.defineProperty(screen.orientation, 'unlock', { configurable: true, value: () => { state.unlocks++; state.locked = false; } });
        }, { mode, opened, storageDenied });
        await page.goto(storageDenied ? `${url}/#guide.md` : url);
        await page.locator('#markdown-content h1').waitFor();
        await settle(page);
        return page;
    };
    const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const clickMode = async (page, active) => {
        await page.locator('#landscape-toggle').click();
        await page.waitForFunction(active => document.getElementById('landscape-toggle').getAttribute('aria-pressed') === String(active) && document.getElementById('landscape-toggle').getAttribute('aria-busy') === 'false', active);
        await settle(page);
    };
    const nativeState = page => page.evaluate(() => {
        const { locks, unlocks, requests, exits, locked } = window.nativeState;
        return { locks, unlocks, requests, exits, locked, fullscreen: Boolean(document.fullscreenElement) };
    });
    const screenshot = async (page, name) => {
        if (!process.env.MARKDOWN_VIEW_SCREENSHOTS) return;
        await fs.mkdir(process.env.MARKDOWN_VIEW_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MARKDOWN_VIEW_SCREENSHOTS, name), animations: 'disabled' });
    };

    await t.test('the sticky control fits at 320px and 390px and is hidden on desktop', async subtest => {
        for (const width of [320, 390]) {
            const page = await makePage(subtest, { width, opened: files });
            const button = page.locator('#landscape-toggle');
            const initial = await button.boundingBox();
            assert.ok(initial.width >= 44 && initial.height >= 44);
            const overflow = await page.locator('#tabs-overflow-toggle').boundingBox();
            assert.ok(overflow.x + overflow.width <= initial.x + 1, 'rotation stays after the dropdown');
            assert.ok(initial.x + initial.width <= width, 'the exit control is within the viewport');
            await page.locator('.content').evaluate(content => { content.scrollTop = 700; });
            await settle(page);
            assert.equal((await button.boundingBox()).y, initial.y, 'the control remains visible while reading');
            await page.locator('#tabs-overflow-toggle').click();
            assert.equal(await page.locator('.tabs-overflow-item').count(), files.length);
        }
        const desktop = await makePage(subtest, { width: 1280, mobile: false });
        assert.equal(await desktop.locator('#landscape-toggle').isVisible(), false);
    });

    await t.test('narrow desktop windows show a hint without requesting fullscreen or orientation locking', async subtest => {
        for (const { width, height } of [{ width: 390, height: 844 }, { width: 600, height: 400 }]) {
            const page = await makePage(subtest, { mode: 'success', width, height, mobile: false });
            await page.locator('.content').evaluate(content => { content.scrollTop = 700; });
            await settle(page);
            const bounds = await page.locator('#landscape-toggle').boundingBox();
            await page.locator('#landscape-toggle').click();
            await settle(page);
            assert.deepEqual(await nativeState(page), { locks: [], unlocks: 0, requests: 0, exits: 0, locked: false, fullscreen: false }, 'even exposed APIs must not be probed by entering fullscreen on desktop');
            assert.equal(await page.locator('#landscape-hint').isVisible(), true);
            assert.match(await page.locator('#landscape-hint-text').textContent(), /desktop/i);
            assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-pressed'), 'false');
            assert.equal(await page.locator('.container').evaluate(container => container.classList.contains('landscape-reading')), false);
            assert.deepEqual(await page.locator('#landscape-toggle').boundingBox(), bounds);
            assert.equal(await page.locator('.content').evaluate(content => content.scrollTop), 700);
            await page.locator('#landscape-hint-close').click();
            assert.equal(await page.locator('#landscape-hint').isVisible(), false);
            await page.locator('#landscape-toggle').click();
            assert.equal((await nativeState(page)).requests, 0, 'repeated clicks never flash fullscreen');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#landscape-hint').isVisible(), false);
        }
    });

    await t.test('missing rotation APIs show a dismissible hint and preserve the document and reading position', async subtest => {
        const page = await makePage(subtest);
        await screenshot(page, 'landscape-portrait.png');
        const originalBounds = await page.locator('#landscape-toggle').boundingBox();
        await clickMode(page, true);
        assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-label'), 'Exit landscape reading');
        assert.equal(await page.locator('#landscape-hint').isVisible(), true);
        assert.match(await page.locator('#landscape-hint-text').textContent(), /Turn your phone sideways/);
        assert.deepEqual(await page.locator('#landscape-toggle').boundingBox(), originalBounds);
        await screenshot(page, 'landscape-manual-hint.png');
        await page.locator('#landscape-hint-close').click();
        assert.equal(await page.locator('#landscape-hint').isVisible(), false);
        assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-describedby'), null);
        await page.locator('.content').evaluate(content => { content.scrollTop = 800; });
        await settle(page);
        await clickMode(page, false);
        assert.equal(await page.locator('.content').evaluate(content => content.scrollTop), 800);
        assert.equal(await page.locator('#tabs .tab.active').getAttribute('data-path'), 'guide.md');
        assert.equal(await page.locator('#tabs .tab').count(), 2);
        assert.deepEqual(await nativeState(page), { locks: [], unlocks: 0, requests: 0, exits: 0, locked: false, fullscreen: false });
    });

    await t.test('manual landscape rotation keeps drawer navigation and the exit control on wide phones', async subtest => {
        const page = await makePage(subtest);
        await page.locator('#mobile-menu-toggle').click();
        await page.locator('#search-input').fill('guide');
        await settle(page);
        assert.equal(await page.locator('#file-tree .tree-item:visible').count(), 1);
        await page.locator('#sidebar-toggle').click();
        await clickMode(page, true);
        await page.setViewportSize({ width: 844, height: 390 });
        await page.locator('#landscape-hint').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#mobile-menu-toggle').isVisible(), true);
        assert.equal(await page.locator('#content-sidebar-toggle').isVisible(), false);
        assert.equal(await page.locator('#landscape-toggle').isVisible(), true);
        assert.equal(await page.locator('#landscape-toggle .landscape-toggle-label').textContent(), 'Exit');
        assert.equal(await page.locator('#drag-resizer').isVisible(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        assert.ok((await page.locator('#markdown-content').boundingBox()).width > 800);
        await screenshot(page, 'landscape-reading.png');
        await page.locator('#mobile-menu-toggle').click();
        assert.equal(await page.locator('#sidebar').evaluate(sidebar => getComputedStyle(sidebar).position), 'fixed');
        assert.equal(await page.locator('#search-input').isVisible(), false);
        assert.equal(await page.locator('.search-label').isVisible(), false);
        assert.equal(await page.locator('#sidebar .title').isVisible(), true);
        assert.equal(await page.locator('#file-tree .tree-item:visible').count(), files.length, 'hidden search does not hide other documents');
        await screenshot(page, 'landscape-menu.png');
        await page.locator('#sidebar-toggle').click();
        await clickMode(page, false);
        await page.locator('#mobile-menu-toggle').click();
        assert.equal(await page.locator('#search-input').isVisible(), true);
        assert.equal(await page.locator('.search-label').isVisible(), true);
        assert.equal(await page.locator('#search-input').inputValue(), 'guide');
        assert.equal(await page.locator('#file-tree .tree-item:visible').count(), 1, 'leaving restores the visible search and its results');
        // Loading directly in landscape must use the same drawer default before JS initializes.
        const fresh = await makePage(subtest, { width: 932, height: 430 });
        assert.equal(await fresh.locator('#mobile-menu-toggle').isVisible(), true);
        assert.equal(await fresh.locator('#mobile-menu-toggle').getAttribute('aria-expanded'), 'false');
    });

    await t.test('entry requests fullscreen directly before locking orientation, matching the PDF reader', async subtest => {
        const page = await makePage(subtest, { mode: 'success' });
        await clickMode(page, true);
        assert.equal(await page.locator('#landscape-hint').isVisible(), false);
        assert.deepEqual(await page.evaluate(() => window.nativeState.events), ['fullscreen', 'lock']);
        assert.deepEqual(await page.evaluate(() => window.nativeState.fullscreenOptions), { navigationUI: 'hide' });
        assert.deepEqual(await nativeState(page), { locks: ['landscape'], unlocks: 0, requests: 1, exits: 0, locked: true, fullscreen: true });
        await clickMode(page, false);
        assert.equal((await nativeState(page)).unlocks, 1);
        assert.equal((await nativeState(page)).locked, false);
        assert.equal((await nativeState(page)).fullscreen, false);
    });

    await t.test('fullscreen requirements, native dismissal, and a second entry clean up correctly', async subtest => {
        const page = await makePage(subtest, { mode: 'fullscreen' });
        await clickMode(page, true);
        assert.deepEqual(await nativeState(page), { locks: ['landscape'], unlocks: 0, requests: 1, exits: 0, locked: true, fullscreen: true });
        await page.evaluate(() => window.nativeState.dismissFullscreen());
        await page.waitForFunction(() => document.getElementById('landscape-toggle').getAttribute('aria-pressed') === 'false');
        assert.equal((await nativeState(page)).unlocks, 1);
        await clickMode(page, true);
        await clickMode(page, false);
        assert.equal((await nativeState(page)).exits, 1);
        assert.equal((await nativeState(page)).unlocks, 2);
        assert.equal((await nativeState(page)).fullscreen, false);
    });

    for (const mode of ['unsupported', 'fullscreen-denied', 'lock-denied', 'missing-lock']) {
        await t.test(`${mode} preserves usable fullscreen or in-page reading until exit`, async subtest => {
            const page = await makePage(subtest, { mode });
            await clickMode(page, true);
            assert.equal(await page.locator('#landscape-hint').isVisible(), true);
            const state = await nativeState(page);
            assert.equal(state.fullscreen, mode !== 'fullscreen-denied');
            assert.equal(state.locked, false);
            assert.equal(state.requests, 1);
            assert.equal(state.exits, 0, 'failed orientation locking does not discard fullscreen');
            await clickMode(page, false);
            assert.equal((await nativeState(page)).fullscreen, false);
        });
    }

    await t.test('existing fullscreen belongs to its original caller', async subtest => {
        const page = await makePage(subtest, { mode: 'external' });
        await clickMode(page, true);
        await clickMode(page, false);
        assert.deepEqual(await nativeState(page), { locks: ['landscape'], unlocks: 1, requests: 0, exits: 0, locked: false, fullscreen: true });
    });

    for (const mode of ['pending-lock', 'pending-fullscreen']) {
        await t.test(`exiting during ${mode} releases the eventual native result`, async subtest => {
            const page = await makePage(subtest, { mode });
            await page.locator('#landscape-toggle').click();
            await page.waitForFunction(mode => typeof window.nativeState[mode === 'pending-lock' ? 'resolveLock' : 'resolveFullscreen'] === 'function', mode);
            assert.equal(await page.locator('#landscape-toggle').isEnabled(), true, 'exit remains available while native requests are pending');
            await page.locator('#landscape-toggle').click();
            assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-pressed'), 'false');
            await page.evaluate(mode => window.nativeState[mode === 'pending-lock' ? 'resolveLock' : 'resolveFullscreen'](), mode);
            await page.waitForFunction(() => document.getElementById('landscape-toggle').getAttribute('aria-busy') === 'false');
            const state = await nativeState(page);
            assert.equal(state.locked, false);
            assert.equal(state.fullscreen, false);
            assert.equal(state.unlocks, mode === 'pending-lock' ? 1 : 0);
            assert.equal(state.exits, 1);
            assert.equal(await page.locator('#landscape-hint').isVisible(), false);
        });
    }

    await t.test('orientation locking still runs when fullscreen is unavailable', async subtest => {
        const page = await makePage(subtest, { mode: 'no-fullscreen' });
        await clickMode(page, true);
        assert.deepEqual(await nativeState(page), { locks: ['landscape'], unlocks: 0, requests: 0, exits: 0, locked: true, fullscreen: false });
        await clickMode(page, false);
        assert.equal((await nativeState(page)).unlocks, 1);
    });

    await t.test('actual browser APIs complete entry and exit without stubs or uncaught errors', async subtest => {
        const page = await makePage(subtest, { mode: 'native' });
        await clickMode(page, true);
        assert.equal(await page.locator('#landscape-toggle').isVisible(), true);
        await clickMode(page, false);
        assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false);
    });

    await t.test('Escape closes the hint or tab list before exiting reading mode', async subtest => {
        const page = await makePage(subtest, { opened: files });
        await clickMode(page, true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#landscape-hint').isVisible(), false);
        assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-pressed'), 'true');
        await page.locator('#tabs-overflow-toggle').click();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#tabs-overflow-panel').isVisible(), false);
        assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#landscape-toggle').getAttribute('aria-pressed'), 'false');
    });

    await t.test('switching tabs in reading mode keeps the new document and its scroll position on exit', async subtest => {
        const page = await makePage(subtest);
        await clickMode(page, true);
        await page.locator('#landscape-hint-close').click();
        await page.locator('#tabs .tab').first().click();
        await page.waitForFunction(() => document.querySelector('#tabs .tab.active').dataset.path === 'other.md');
        await settle(page);
        await page.locator('.content').evaluate(content => { content.scrollTop = 1100; });
        await settle(page);
        await clickMode(page, false);
        assert.equal(await page.locator('#tabs .tab.active').getAttribute('data-path'), 'other.md');
        assert.equal(await page.locator('.content').evaluate(content => content.scrollTop), 1100);
        assert.equal(await page.evaluate(() => localStorage.getItem('markdown-view.sidebar-collapsed.v1')), 'false');
    });

    await t.test('unavailable storage and a change to desktop layout leave usable controls', async subtest => {
        const page = await makePage(subtest, { storageDenied: true });
        await clickMode(page, true);
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.locator('#landscape-toggle').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => !document.querySelector('.container').classList.contains('landscape-reading'));
        assert.equal(await page.locator('#landscape-hint').isVisible(), false);
    });

    assert.deepEqual(errors, [], 'no uncaught browser errors');
});

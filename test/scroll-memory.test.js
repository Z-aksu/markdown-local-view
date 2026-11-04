const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const storageKey = 'markdown-view.tabs.v1';

function createReader(saved) {
    const storage = new Map(saved ? [[storageKey, JSON.stringify(saved)]] : []);
    const frames = [];
    const events = new Map();
    let scrollListener;
    let scrollTop = 0;
    let maxScroll = 10000;
    let html = '';
    let images = [];
    const content = {
        get scrollTop() { return scrollTop; },
        set scrollTop(value) { scrollTop = Math.min(maxScroll, Math.max(0, value)); },
        addEventListener(type, listener) { if (type === 'scroll') scrollListener = listener; }
    };
    const article = {
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value;
            maxScroll = value.includes('loading-state') ? 0 : 10000;
            content.scrollTop = scrollTop;
        },
        querySelectorAll(selector) { return selector === 'img' ? images : []; }
    };
    const context = vm.createContext({
        console,
        document: {
            addEventListener() {},
            querySelector() { return content; },
            querySelectorAll() { return []; },
            getElementById(id) {
                return id === 'markdown-content' ? article : { scrollIntoView() { content.scrollTop = 1800; } };
            }
        },
        window: {
            history: { scrollRestoration: 'auto' },
            addEventListener(type, listener) { events.set(type, listener); },
            setTimeout() { return 1; },
            clearTimeout() {}
        },
        localStorage: {
            getItem(key) { return storage.get(key) || null; },
            setItem(key, value) { storage.set(key, value); }
        },
        requestAnimationFrame(callback) { frames.push(callback); return frames.length; }
    });
    const run = source => vm.runInContext(source, context);
    run(script);
    run('renderTabs = () => {}; loadContent = () => {}; setupContentScrollMemory(); restoreTabs();');
    const frame = () => {
        scrollListener();
        const pending = frames.splice(0);
        pending.forEach(callback => callback());
    };
    return {
        content,
        run,
        frame,
        setMaxScroll(value) { maxScroll = value; content.scrollTop = scrollTop; },
        setImages(count) {
            images = Array.from({ length: count }, () => ({
                complete: false,
                listeners: {},
                addEventListener(type, listener) { this.listeners[type] = listener; },
                settle() { this.complete = true; this.listeners.load?.(); }
            }));
            return images;
        },
        settle() { frame(); frame(); frame(); },
        select(file, top = 0, loading = false) {
            run(`if (!tabs.has(${JSON.stringify(file)})) tabs.set(${JSON.stringify(file)}, {
                path: ${JSON.stringify(file)}, title: ${JSON.stringify(file)},
                scrollTop: ${top}, loading: ${loading}, requested: true, html: '<h1>Document</h1>'
            }); activateTab(${JSON.stringify(file)});`);
        },
        loaded() { run("{ const tab = tabs.get(activePath); tab.html = '<h1>Document</h1>'; tab.loading = false; renderTabContent(tab); }"); },
        save(event = 'beforeunload') {
            events.get(event)();
            return JSON.parse(storage.get(storageKey));
        },
        snapshot() { run('persistTabs();'); return JSON.parse(storage.get(storageKey)); },
        history: context.window.history
    };
}

test('refresh saves the visible position even before the scroll event runs', () => {
    const reader = createReader();
    reader.select('guide.md');
    reader.settle();
    reader.content.scrollTop = 1000;
    assert.equal(reader.save().tabs[0].scrollTop, 1000);
});

test('pagehide also saves the latest visible position', () => {
    const reader = createReader();
    reader.select('guide.md');
    reader.settle();
    reader.content.scrollTop = 1250;
    assert.equal(reader.save('pagehide').tabs[0].scrollTop, 1250);
});

test('loading placeholders cannot overwrite a saved reading position', () => {
    const reader = createReader();
    reader.select('guide.md', 1000, true);
    reader.settle();
    assert.equal(reader.content.scrollTop, 0);
    assert.equal(reader.save().tabs[0].scrollTop, 1000);
    reader.loaded();
    reader.settle();
    assert.equal(reader.content.scrollTop, 1000);
});

test('switching tabs captures scrolling before a pending scroll event', () => {
    const reader = createReader();
    reader.select('first.md');
    reader.settle();
    reader.content.scrollTop = 950;
    reader.select('second.md', 400);
    reader.settle();
    assert.equal(reader.content.scrollTop, 400);
    reader.select('first.md');
    reader.settle();
    assert.equal(reader.content.scrollTop, 950);
});

test('stale restoration frames cannot scroll the newly selected loading tab', () => {
    const reader = createReader();
    reader.select('first.md', 950);
    reader.select('second.md', 400, true);
    reader.frame();
    assert.equal(reader.content.scrollTop, 0);
    assert.deepEqual(reader.snapshot().tabs.map(tab => tab.scrollTop), [950, 400]);
    reader.loaded();
    reader.settle();
    assert.equal(reader.content.scrollTop, 400);
});

test('refreshing during restoration preserves the target position', () => {
    const reader = createReader();
    reader.select('guide.md', 1400);
    assert.equal(reader.save().tabs[0].scrollTop, 1400);
    reader.settle();
    assert.equal(reader.content.scrollTop, 1400);
});

test('repeated refreshes retain the position across slow content loads', () => {
    let saved = { activePath: 'guide.md', tabs: [{ path: 'guide.md', scrollTop: 1750 }] };
    for (let refresh = 0; refresh < 6; refresh++) {
        const reader = createReader(saved);
        reader.run("activateTab('guide.md');");
        reader.settle();
        saved = reader.save();
        assert.equal(saved.tabs[0].scrollTop, 1750);
        reader.loaded();
        reader.settle();
        assert.equal(reader.content.scrollTop, 1750);
        saved = reader.save();
    }
});

test('scrolling back to the top is remembered as an intentional position', () => {
    const reader = createReader();
    reader.select('guide.md', 1000);
    reader.settle();
    reader.content.scrollTop = 0;
    assert.equal(reader.save().tabs[0].scrollTop, 0);
});

test('anchor navigation still takes precedence over a saved offset', () => {
    const reader = createReader();
    reader.run("activeAnchor = 'section';");
    reader.select('guide.md', 500);
    reader.settle();
    assert.equal(reader.content.scrollTop, 1800);
    assert.equal(reader.save().tabs[0].scrollTop, 1800);
});

test('the application owns scroll restoration', () => {
    assert.equal(createReader().history.scrollRestoration, 'manual');
});

test('unloaded images cannot replace the saved position with a clamped offset', () => {
    let saved = { activePath: 'images.md', tabs: [{ path: 'images.md', scrollTop: 1600 }] };
    for (let refresh = 0; refresh < 3; refresh++) {
        const reader = createReader(saved);
        const images = reader.setImages(14);
        reader.run("activateTab('images.md');");
        reader.loaded();
        reader.setMaxScroll(0);
        reader.settle();
        assert.equal(reader.content.scrollTop, 0);
        assert.equal(reader.save().tabs[0].scrollTop, 1600);
        for (const image of images.slice(0, -1)) {
            reader.setMaxScroll(0);
            image.settle();
            reader.settle();
            assert.equal(reader.save().tabs[0].scrollTop, 1600);
        }
        reader.setMaxScroll(10000);
        images.at(-1).settle();
        reader.settle();
        assert.equal(reader.content.scrollTop, 1600);
        saved = reader.save();
    }
});

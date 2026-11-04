let allTreeItems = [];
const tabs = new Map();
const tabElements = new Map();
const TABS_STORAGE_KEY = 'markdown-view.tabs.v1';
const SIDEBAR_STORAGE_KEY = 'markdown-view.sidebar-collapsed.v1';
let activePath = null;
let activeAnchor = '';
let persistTimer = null;
let lastFocusedElement = null;
let tabsLayoutFrame = null;
let contentRenderId = 0;
let scrollMemoryPath = null;
let pendingContentRestore = null;
const MOBILE_LAYOUT_QUERY = '(max-width: 768px), (max-height: 768px) and (pointer: coarse)';
const isMobileLayout = () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches;

if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

const uiText = {
    selectFileTitle: 'Select a file to view',
    selectFileDescription: 'Choose a Markdown document from the sidebar to start reading.',
    loading: 'Loading…',
    loadingTree: 'Loading document tree…',
    loadTreeError: 'Could not load the document tree. Refresh the page to try again.',
    noMarkdown: 'No Markdown files found',
    emptyDirectory: 'Empty directory',
    loadContentError: 'Could not load the document. Please try again.',
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    openMenu: 'Open document menu',
    closeMenu: 'Close document menu',
    closeDocument: 'Close document',
    closeImage: 'Close image preview',
    searchPlaceholder: 'Search files…',
    tabLoading: 'Loading…',
    enterLandscape: 'Enter landscape reading',
    exitLandscape: 'Exit landscape reading',
    landscapeHint: 'Turn your phone sideways to read in landscape. If the screen stays upright, enable auto-rotate in your phone settings.',
    desktopLandscapeHint: "Landscape reading is available on phones and tablets. On desktop, use your browser's fullscreen option."
};

document.addEventListener('DOMContentLoaded', async () => {
    const treePromise = fetchFileTree();
    restoreTabs();
    setupResizer();
    setupSidebar();
    setupLightbox();
    setupSearch();
    setupTabs();
    setupLandscapeReading();
    setupContentScrollMemory();
    renderTabs();

    const tree = await treePromise;
    const availablePaths = tree ? removeMissingTabs(tree) : null;

    if (availablePaths && window.location.hash) {
        const hashPath = getHashPath();
        if (!availablePaths.has(hashPath)) {
            window.location.hash = activePath || '';
            if (!activePath) handleHashChange();
            return;
        }
    }

    if (!window.location.hash && activePath) {
        window.location.hash = activePath;
    } else {
        handleHashChange();
    }
});

window.addEventListener('beforeunload', persistTabs);
window.addEventListener('pagehide', persistTabs);
window.addEventListener('hashchange', handleHashChange);

function getHashState() {
    const hash = window.location.hash.slice(1);
    if (!hash) return { path: '', anchor: '' };

    if (hash.startsWith('file/')) {
        const separator = hash.indexOf('#', 5);
        const encodedPath = separator === -1 ? hash.slice(5) : hash.slice(5, separator);
        const encodedAnchor = separator === -1 ? '' : hash.slice(separator + 1);
        try {
            return { path: decodeURIComponent(encodedPath), anchor: decodeURIComponent(encodedAnchor) };
        } catch (_) {
            return { path: encodedPath, anchor: encodedAnchor };
        }
    }

    try { return { path: decodeURIComponent(hash), anchor: '' }; } catch (_) { return { path: hash, anchor: '' }; }
}

function getHashPath() {
    return getHashState().path;
}

function setEmptyState() {
    contentRenderId++;
    scrollMemoryPath = null;
    pendingContentRestore = null;
    document.getElementById('markdown-content').innerHTML = `
        <div class="empty-state">
            <span class="empty-state-icon" aria-hidden="true">▤</span>
            <h1>${uiText.selectFileTitle}</h1>
            <p>${uiText.selectFileDescription}</p>
        </div>`;
}

function handleHashChange() {
    const { path, anchor } = getHashState();
    activeAnchor = anchor;
    if (path) {
        activateTab(path);
        highlightTreeItem(path);
        return;
    }

    activePath = null;
    activeAnchor = '';
    persistTabs();
    setEmptyState();
    renderTabs();
    document.querySelectorAll('.tree-item').forEach(element => element.classList.remove('active'));
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
    const container = document.querySelector('.container');
    const sidebar = document.getElementById('sidebar');
    const collapseButton = document.getElementById('sidebar-toggle');
    const expandButton = document.getElementById('content-sidebar-toggle');
    const mobileButton = document.getElementById('mobile-menu-toggle');
    if (!container || !sidebar) return;
    container.classList.toggle('sidebar-collapsed', Boolean(collapsed));
    const expanded = !collapsed;
    collapseButton?.setAttribute('aria-expanded', String(expanded));
    expandButton?.setAttribute('aria-expanded', String(expanded));
    collapseButton?.setAttribute('aria-label', expanded ? uiText.collapseSidebar : uiText.expandSidebar);
    expandButton?.setAttribute('aria-label', expanded ? uiText.collapseSidebar : uiText.expandSidebar);
    mobileButton?.setAttribute('aria-expanded', String(expanded));
    mobileButton?.setAttribute('aria-label', expanded ? uiText.closeMenu : uiText.openMenu);
    if (persist && !isMobileLayout()) {
        try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed)); } catch (_) { /* ignore */ }
    }
}

function setupSidebar() {
    const container = document.querySelector('.container');
    let collapsed = isMobileLayout();
    try {
        if (!collapsed) collapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
    } catch (_) { /* localStorage may be unavailable */ }
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => setSidebarCollapsed(true));
    document.getElementById('content-sidebar-toggle')?.addEventListener('click', () => setSidebarCollapsed(false));
    document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => setSidebarCollapsed(!container.classList.contains('sidebar-collapsed')));
    document.getElementById('sidebar-backdrop')?.addEventListener('click', () => setSidebarCollapsed(true));
    window.matchMedia(MOBILE_LAYOUT_QUERY).addEventListener('change', event => {
        if (event.matches) setSidebarCollapsed(true, { persist: false });
    });
    setSidebarCollapsed(collapsed);
}

function setupLandscapeReading() {
    const button = document.getElementById('landscape-toggle');
    const container = document.querySelector('.container');
    const content = document.querySelector('.content');
    const hint = document.getElementById('landscape-hint');
    const hintText = document.getElementById('landscape-hint-text');
    const orientation = window.screen.orientation;
    const landscape = window.matchMedia('(orientation: landscape)');
    let session = null;
    let pending = false;
    let exiting = false;

    const hideHint = () => {
        hint.hidden = true;
        hintText.textContent = '';
        button.removeAttribute('aria-describedby');
    };
    const showHint = message => {
        hint.hidden = false;
        hintText.textContent = message;
        button.setAttribute('aria-describedby', 'landscape-hint-text');
    };
    const updateButton = () => {
        const label = session ? uiText.exitLandscape : uiText.enterLandscape;
        button.setAttribute('aria-pressed', String(Boolean(session)));
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-busy', String(pending || exiting));
        button.title = label;
        button.querySelector('.landscape-toggle-label').textContent = session ? 'Exit' : 'Landscape';
        // The active control stays usable to cancel an in-flight native request.
        button.disabled = (pending || exiting) && !session;
    };
    const preserveScroll = change => {
        const path = activePath;
        const top = content.scrollTop;
        change();
        requestAnimationFrame(() => {
            if (path === activePath) content.scrollTop = top;
        });
    };
    const releaseNative = async current => {
        current.usesFullscreen = false;
        if (current.locked) {
            current.locked = false;
            try { orientation.unlock(); } catch (_) { /* The browser may already have released the lock. */ }
        }
        if (current.fullscreenOwned) {
            current.fullscreenOwned = false;
            if (document.fullscreenElement === document.documentElement) {
                try { await document.exitFullscreen(); } catch (_) { /* Native fullscreen controls remain available. */ }
            }
        }
    };
    const exit = async () => {
        const current = session;
        if (!current) return;
        session = null;
        exiting = true;
        hideHint();
        preserveScroll(() => {
            container.classList.remove('landscape-reading');
            if (document.getElementById('search-input').value.trim()) applyTreeSearch();
            setSidebarCollapsed(current.sidebarCollapsed, { persist: false });
        });
        updateButton();
        await releaseNative(current);
        exiting = false;
        updateButton();
    };
    const enter = async () => {
        // A narrow desktop window uses the mobile layout, but requesting
        // fullscreen would immediately widen it and trigger layout cleanup.
        if (!window.matchMedia('(pointer: coarse)').matches) {
            closeTabsDropdown();
            showHint(uiText.desktopLandscapeHint);
            return;
        }
        const current = { sidebarCollapsed: container.classList.contains('sidebar-collapsed'), locked: false, fullscreenOwned: false, usesFullscreen: false };
        session = current;
        pending = true;
        hideHint();
        closeTabsDropdown();
        preserveScroll(() => {
            container.classList.add('landscape-reading');
            if (document.getElementById('search-input').value.trim()) applyTreeSearch();
            setSidebarCollapsed(true, { persist: false });
        });
        updateButton();
        try {
            // Request fullscreen directly while the click still has transient
            // user activation, before awaiting any orientation operation.
            if (!document.fullscreenElement && document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function') {
                try {
                    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
                    current.fullscreenOwned = document.fullscreenElement === document.documentElement;
                } catch (_) { /* Keep in-page reading available if fullscreen is denied. */ }
            }
            if (session !== current) return;
            current.usesFullscreen = Boolean(document.fullscreenElement);
            if (typeof orientation?.lock === 'function' && typeof orientation?.unlock === 'function') {
                await orientation.lock('landscape');
                current.locked = true;
            }
        } catch (_) {
            // A failed direction lock must not discard a usable fullscreen reader.
        } finally {
            if (session !== current) await releaseNative(current);
            pending = false;
            updateButton();
            if (session === current && !current.locked && !landscape.matches) {
                showHint(uiText.landscapeHint);
            }
        }
    };

    button.addEventListener('click', () => { if (session) void exit(); else if (!pending && !exiting) void enter(); });
    document.getElementById('landscape-hint-close').addEventListener('click', () => {
        hideHint();
        button.focus({ preventScroll: true });
    });
    landscape.addEventListener('change', event => { if (event.matches) hideHint(); });
    window.matchMedia(MOBILE_LAYOUT_QUERY).addEventListener('change', event => {
        if (!event.matches) { hideHint(); void exit(); }
    });
    document.addEventListener('fullscreenchange', () => {
        if (session?.usesFullscreen && !document.fullscreenElement) void exit();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented || document.getElementById('image-modal').getAttribute('aria-hidden') === 'false') return;
        if (!hint.hidden) {
            event.preventDefault();
            hideHint();
            button.focus({ preventScroll: true });
        } else if (session) {
            event.preventDefault();
            void exit();
            button.focus({ preventScroll: true });
        }
    });
    window.addEventListener('pagehide', () => { void exit(); });
    updateButton();
}

function activateTab(path) {
    rememberContentScroll();
    let tab = tabs.get(path);
    if (!tab) {
        tab = { path, title: path.split('/').pop(), html: null, scrollTop: 0, loading: true, requested: true };
        tabs.set(path, tab);
        activePath = path;
        renderTabs();
        renderTabContent(tab);
        schedulePersistTabs();
        loadContent(tab);
        return;
    }

    activePath = path;
    renderTabs();
    renderTabContent(tab);
    if (tab.loading && !tab.requested) {
        tab.requested = true;
        loadContent(tab);
    }
    schedulePersistTabs();
}

function restoreTabs() {
    try {
        const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) || 'null');
        if (!saved || !Array.isArray(saved.tabs)) return;
        saved.tabs.forEach(item => {
            if (!item || typeof item.path !== 'string' || !item.path || tabs.has(item.path)) return;
            const scrollTop = Number(item.scrollTop);
            tabs.set(item.path, {
                path: item.path,
                title: item.path.split('/').pop(),
                html: null,
                scrollTop: Number.isFinite(scrollTop) && scrollTop >= 0 ? scrollTop : 0,
                loading: true,
                requested: false
            });
        });
        if (typeof saved.activePath === 'string' && tabs.has(saved.activePath)) activePath = saved.activePath;
        else if (tabs.size > 0) activePath = Array.from(tabs.keys()).at(-1);
    } catch (error) {
        console.warn('Unable to restore open tabs:', error);
    }
}

function removeMissingTabs(items) {
    const availablePaths = new Set();
    const collectPaths = treeItems => treeItems.forEach(item => {
        if (item.type === 'file' && item.path) availablePaths.add(item.path);
        if (Array.isArray(item.children)) collectPaths(item.children);
    });
    collectPaths(items);
    tabs.forEach((_tab, path) => { if (!availablePaths.has(path)) tabs.delete(path); });
    if (!tabs.has(activePath)) activePath = Array.from(tabs.keys()).at(-1) || null;
    renderTabs();
    persistTabs();
    return availablePaths;
}

function persistTabs() {
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = null;
    rememberContentScroll();
    try {
        localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
            activePath,
            tabs: Array.from(tabs.values()).map(tab => ({ path: tab.path, scrollTop: Number.isFinite(tab.scrollTop) ? tab.scrollTop : 0 }))
        }));
    } catch (error) { console.warn('Unable to persist open tabs:', error); }
}

function schedulePersistTabs() {
    if (persistTimer !== null) return;
    persistTimer = window.setTimeout(persistTabs, 150);
}

function renderTabs() {
    const tabsContainer = document.getElementById('tabs');
    const renderedPaths = new Set();
    tabs.forEach(tab => {
        let tabElement = tabElements.get(tab.path);
        if (!tabElement) {
            tabElement = document.createElement('div');
            tabElement.className = 'tab';
            tabElement.dataset.path = tab.path;
            tabElement.setAttribute('role', 'tab');
            const title = document.createElement('span');
            title.className = 'tab-title';
            const close = document.createElement('button');
            close.className = 'tab-close';
            close.type = 'button';
            close.setAttribute('aria-label', `${uiText.closeDocument} ${tab.title}`);
            close.textContent = '×';
            tabElement.append(title, close);
            tabElements.set(tab.path, tabElement);
        }
        tabElement.classList.toggle('active', tab.path === activePath);
        tabElement.setAttribute('aria-selected', String(tab.path === activePath));
        tabElement.setAttribute('tabindex', tab.path === activePath ? '0' : '-1');
        tabElement.title = tab.path;
        tabElement.querySelector('.tab-title').textContent = tab.title;
        tabsContainer.appendChild(tabElement);
        renderedPaths.add(tab.path);
    });
    tabElements.forEach((element, path) => {
        if (!renderedPaths.has(path)) { element.remove(); tabElements.delete(path); }
    });
    if (!document.getElementById('tabs-overflow-panel').hidden) renderTabsDropdown();
    scheduleTabsLayout();
}

function setupTabs() {
    const tabsContainer = document.getElementById('tabs');
    setupTabsDropdown();
    tabsContainer.addEventListener('click', event => {
        const tabElement = event.target.closest('.tab');
        if (!tabElement) return;
        const path = tabElement.dataset.path;
        if (event.target.closest('.tab-close')) { closeTab(path); return; }
        if (getHashPath() !== path) window.location.hash = path;
        else activateTab(path);
    });

    tabsContainer.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const elements = [...tabsContainer.querySelectorAll('.tab')];
        const index = elements.indexOf(event.target.closest('.tab'));
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? elements.length - 1 : Math.max(0, Math.min(elements.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        elements[next]?.focus();
    });
}

function revealActiveTab() {
    const container = document.getElementById('tabs');
    const activeTab = tabElements.get(activePath);
    if (!activeTab) return;
    const bounds = container.getBoundingClientRect();
    const activeBounds = activeTab.getBoundingClientRect();
    if (activeBounds.left < bounds.left) container.scrollLeft += activeBounds.left - bounds.left;
    else if (activeBounds.right > bounds.right) container.scrollLeft += activeBounds.right - bounds.right;
}

function scheduleTabsLayout() {
    if (tabsLayoutFrame !== null) return;
    tabsLayoutFrame = requestAnimationFrame(() => {
        tabsLayoutFrame = null;
        const container = document.getElementById('tabs');
        const overflow = document.getElementById('tabs-overflow');
        // Measure the full available width so the button cannot keep itself visible.
        overflow.hidden = true;
        const isOverflowing = container.scrollWidth > container.clientWidth + 1;
        overflow.hidden = !isOverflowing;
        if (!isOverflowing) {
            const hadFocus = overflow.contains(document.activeElement);
            closeTabsDropdown();
            if (hadFocus) tabElements.get(activePath)?.focus({ preventScroll: true });
        }
        revealActiveTab();
    });
}

function closeTabsDropdown(restoreFocus = false) {
    const button = document.getElementById('tabs-overflow-toggle');
    document.getElementById('tabs-overflow-panel').hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
}

function renderTabsDropdown() {
    const list = document.getElementById('tabs-overflow-list');
    const fragment = document.createDocumentFragment();
    tabs.forEach(tab => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tabs-overflow-item';
        button.dataset.path = tab.path;
        if (tab.path === activePath) button.setAttribute('aria-current', 'page');
        const label = document.createElement('span');
        label.className = 'tabs-overflow-label';
        const title = document.createElement('span');
        title.className = 'tabs-overflow-title';
        title.textContent = tab.title;
        label.appendChild(title);
        if (tab.path !== tab.title) {
            const path = document.createElement('span');
            path.className = 'tabs-overflow-path';
            path.textContent = tab.path;
            label.appendChild(path);
        }
        const check = document.createElement('span');
        check.className = 'tabs-overflow-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = tab.path === activePath ? '✓' : '';
        button.append(label, check);
        item.appendChild(button);
        fragment.appendChild(item);
    });
    list.replaceChildren(fragment);
    document.getElementById('tabs-overflow-count').textContent = tabs.size;
}

function setupTabsDropdown() {
    const overflow = document.getElementById('tabs-overflow');
    const button = document.getElementById('tabs-overflow-toggle');
    const panel = document.getElementById('tabs-overflow-panel');
    const list = document.getElementById('tabs-overflow-list');
    const open = () => {
        renderTabsDropdown();
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        const current = list.querySelector('[aria-current="page"]') || list.querySelector('button');
        current?.focus({ preventScroll: true });
        if (current) list.scrollTop = current.offsetTop - list.offsetTop;
    };
    button.addEventListener('click', () => {
        if (panel.hidden) open();
        else closeTabsDropdown();
    });
    button.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        open();
    });
    list.addEventListener('click', event => {
        const item = event.target.closest('.tabs-overflow-item');
        if (!item) return;
        const path = item.dataset.path;
        closeTabsDropdown();
        if (getHashPath() !== path) window.location.hash = path;
        else activateTab(path);
        tabElements.get(path)?.focus({ preventScroll: true });
    });
    list.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...list.querySelectorAll('button')];
        const index = items.indexOf(event.target.closest('button'));
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
    });
    document.addEventListener('pointerdown', event => {
        if (!overflow.contains(event.target)) closeTabsDropdown();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) {
            event.preventDefault();
            closeTabsDropdown(true);
        }
    });
    overflow.addEventListener('focusout', event => {
        if (!overflow.contains(event.relatedTarget)) closeTabsDropdown();
    });
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(scheduleTabsLayout);
        observer.observe(document.getElementById('tabs'));
    }
    window.addEventListener('resize', scheduleTabsLayout);
    document.fonts?.ready.then(scheduleTabsLayout);
}

function renderTabContent(tab) {
    rememberContentScroll();
    const renderId = ++contentRenderId;
    scrollMemoryPath = null;
    pendingContentRestore = null;
    const contentDiv = document.getElementById('markdown-content');
    contentDiv.innerHTML = tab.loading ? `<div class="loading-state"><span class="loading-spinner" aria-hidden="true"></span>${uiText.loading}</div>` : tab.html;
    renderMath(contentDiv);
    attachImageListeners();
    if (tab.loading) return;

    const restore = { renderId, path: tab.path };
    pendingContentRestore = restore;
    const isCurrent = () => pendingContentRestore === restore && activePath === tab.path && renderId === contentRenderId;
    const applyPosition = () => {
        if (!isCurrent()) return;
        const content = document.querySelector('.content');
        content.scrollTop = tab.scrollTop || 0;
        if (activeAnchor && activePath === tab.path) {
            document.getElementById(activeAnchor)?.scrollIntoView({ block: 'start' });
        }
    };
    const images = Array.from(contentDiv.querySelectorAll('img')).filter(image => !image.complete);
    let remainingImages = images.length;
    const imageSettled = () => {
        if (!isCurrent()) return;
        remainingImages--;
        requestAnimationFrame(applyPosition);
        if (remainingImages === 0) requestAnimationFrame(finishRestore);
    };
    const finishRestore = () => {
        if (!isCurrent()) return;
        applyPosition();
        pendingContentRestore = null;
        scrollMemoryPath = tab.path;
        rememberContentScroll();
        schedulePersistTabs();
    };
    images.forEach(image => {
        let settled = false;
        const onSettled = () => {
            if (settled) return;
            settled = true;
            imageSettled();
        };
        image.addEventListener('load', onSettled, { once: true });
        image.addEventListener('error', onSettled, { once: true });
        if (image.complete) onSettled();
    });
    requestAnimationFrame(() => {
        applyPosition();
        if (remainingImages === 0) requestAnimationFrame(finishRestore);
    });
}

function renderMath(contentDiv) {
    if (typeof renderMathInElement !== 'function') return;
    renderMathInElement(contentDiv, {
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        fleqn: false,
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false }
        ]
    });
}

function closeTab(path) {
    const wasActive = activePath === path;
    tabs.delete(path);
    tabElements.get(path)?.remove();
    tabElements.delete(path);
    schedulePersistTabs();
    if (!wasActive) { renderTabs(); return; }
    const nextPath = Array.from(tabs.keys()).at(-1);
    window.location.hash = nextPath || '';
}

async function fetchFileTree() {
    const treeContainer = document.getElementById('file-tree');
    treeContainer.innerHTML = `<div class="tree-status">${uiText.loadingTree}</div>`;
    try {
        const response = await fetch('/api/tree');
        if (!response.ok) throw new Error(`Tree request failed: ${response.status}`);
        const tree = await response.json();
        renderTree(tree, treeContainer);
        return tree;
    } catch (error) {
        console.error('Error fetching file tree:', error);
        treeContainer.innerHTML = `<div class="tree-status tree-status-error">${uiText.loadTreeError}</div>`;
        return null;
    }
}

function renderTree(items, container) {
    if (!items || items.length === 0) {
        container.innerHTML = `<div class="tree-status">${uiText.noMarkdown}</div>`;
        return;
    }
    items.sort((a, b) => {
        const aMatch = a.name.match(/^(\d+)/);
        const bMatch = b.name.match(/^(\d+)/);
        if (aMatch && bMatch && Number(aMatch[1]) !== Number(bMatch[1])) return Number(aMatch[1]) - Number(bMatch[1]);
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `tree-item ${item.type}`;
        itemDiv.dataset.name = item.name.toLocaleLowerCase();
        if (item.path) itemDiv.dataset.path = item.path;

        const nameSpan = document.createElement('div');
        nameSpan.className = 'item-name';
        nameSpan.title = item.name;
        nameSpan.setAttribute('role', item.type === 'directory' ? 'button' : 'link');
        nameSpan.tabIndex = 0;
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = item.type === 'directory' ? '📁' : '📄';
        const text = document.createElement('span');
        text.className = 'item-text';
        text.textContent = item.name;
        nameSpan.append(icon, text);
        itemDiv.appendChild(nameSpan);

        if (item.type === 'directory') {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'children';
            itemDiv.appendChild(childrenContainer);
            if (item.children?.length) renderTree(item.children, childrenContainer);
            else childrenContainer.innerHTML = `<div class="empty-directory">${uiText.emptyDirectory}</div>`;
            const toggle = () => toggleDirectory(childrenContainer, nameSpan);
            nameSpan.addEventListener('click', event => { event.stopPropagation(); toggle(); });
            nameSpan.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
        } else {
            const open = () => { window.location.hash = item.path; };
            nameSpan.addEventListener('click', event => { event.stopPropagation(); open(); });
            nameSpan.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        }
        container.appendChild(itemDiv);
    });
}

function toggleDirectory(childrenContainer, nameSpan) {
    const expanded = childrenContainer.classList.toggle('expanded');
    nameSpan.setAttribute('aria-expanded', String(expanded));
    const icon = nameSpan.querySelector('.icon');
    if (icon) icon.textContent = expanded ? '📂' : '📁';
}

function highlightTreeItem(path) {
    document.querySelectorAll('.tree-item').forEach(element => element.classList.remove('active'));
    const targetItem = [...document.querySelectorAll('.tree-item.file')].find(item => item.dataset.path === path);
    if (!targetItem) return;
    targetItem.classList.add('active');
    let parent = targetItem.parentElement;
    while (parent) {
        if (parent.classList.contains('children')) {
            parent.classList.add('expanded');
            const dirItem = parent.parentElement;
            const name = dirItem?.querySelector(':scope > .item-name');
            if (name) {
                name.setAttribute('aria-expanded', 'true');
                name.querySelector('.icon').textContent = '📂';
            }
        }
        parent = parent.parentElement;
        if (parent?.id === 'file-tree') break;
    }
    targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadContent(tab) {
    try {
        const response = await fetch(`/api/content?path=${encodeURIComponent(tab.path)}`);
        if (!response.ok) throw new Error(`Content request failed: ${response.status}`);
        const data = await response.json();
        tab.html = data.html;
        tab.loading = false;
        if (activePath === tab.path) renderTabContent(tab);
    } catch (error) {
        console.error('Error loading file content:', error);
        tab.html = `<div class="error-state"><strong>${uiText.loadContentError}</strong><button type="button" class="retry-button">${uiText.loading}</button></div>`;
        tab.loading = false;
        if (activePath === tab.path) {
            renderTabContent(tab);
            document.querySelector('.retry-button')?.addEventListener('click', () => {
                tab.loading = true;
                tab.requested = true;
                renderTabContent(tab);
                loadContent(tab);
            }, { once: true });
        }
    }
}

function setupSearch() {
    const searchInput = document.getElementById('search-input');
    let searchFrame = null;
    searchInput.addEventListener('input', () => {
        if (searchFrame !== null) cancelAnimationFrame(searchFrame);
        searchFrame = requestAnimationFrame(() => {
            searchFrame = null;
            applyTreeSearch();
        });
    });
}

function applyTreeSearch() {
    const treeRoot = document.getElementById('file-tree');
    // A hidden search field must not leave the drawer silently filtered. Keep
    // the query and folder expansion so both remain available after leaving.
    if (document.querySelector('.container').classList.contains('landscape-reading')) {
        treeRoot.querySelectorAll('.tree-item').forEach(item => item.style.removeProperty('display'));
        return;
    }
    const query = document.getElementById('search-input').value.toLocaleLowerCase().trim();
    if (!query) resetTree(treeRoot);
    else filterTree(treeRoot, query);
}

function filterTree(container, query) {
    let hasMatch = false;
    [...container.children].forEach(item => {
        if (!item.classList.contains('tree-item')) return;
        const isDir = item.classList.contains('directory');
        const childMatch = isDir && item.querySelector('.children') ? filterTree(item.querySelector('.children'), query) : false;
        const selfMatch = item.dataset.name.includes(query);
        if (selfMatch || childMatch) {
            item.style.display = 'block';
            hasMatch = true;
            if (isDir && childMatch && !item.querySelector('.children').classList.contains('expanded')) toggleDirectory(item.querySelector('.children'), item.querySelector('.item-name'));
        } else item.style.display = 'none';
    });
    return hasMatch;
}

function resetTree(container) {
    container.querySelectorAll('.tree-item').forEach(item => {
        item.style.display = 'block';
        if (item.classList.contains('directory')) {
            const children = item.querySelector('.children');
            children.classList.remove('expanded');
            item.querySelector('.item-name').setAttribute('aria-expanded', 'false');
            item.querySelector('.icon').textContent = '📁';
        }
    });
}

function setupResizer() {
    const sidebar = document.querySelector('.sidebar');
    const resizer = document.getElementById('drag-resizer');
    if (!resizer || !sidebar) return;
    let isResizing = false;
    const setWidth = width => {
        const value = `${Math.max(180, Math.min(window.innerWidth * 0.5, width))}px`;
        // Keep the user's preferred width without creating inline width/flex-basis
        // declarations that can override the collapsed layout state.
        sidebar.style.removeProperty('width');
        sidebar.style.removeProperty('flex-basis');
        sidebar.style.setProperty('--sidebar-width', value);
    };
    const resize = event => {
        if (!isResizing) return;
        event.preventDefault();
        setWidth(event.clientX);
    };
    resizer.addEventListener('pointerdown', event => {
        isResizing = true;
        resizer.setPointerCapture?.(event.pointerId);
        document.body.classList.add('is-resizing');
    });
    resizer.addEventListener('pointermove', resize);
    resizer.addEventListener('pointerup', () => { isResizing = false; document.body.classList.remove('is-resizing'); });
    resizer.addEventListener('pointercancel', () => { isResizing = false; document.body.classList.remove('is-resizing'); });
    resizer.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const current = sidebar.getBoundingClientRect().width;
        setWidth(current + (event.key === 'ArrowRight' ? 16 : -16));
    });
}

function rememberContentScroll() {
    if (!activePath || scrollMemoryPath !== activePath) return false;
    const tab = tabs.get(activePath);
    if (!tab || tab.loading) return false;
    tab.scrollTop = document.querySelector('.content').scrollTop;
    return true;
}

function setupContentScrollMemory() {
    const content = document.querySelector('.content');
    const cancelRestore = () => {
        if (!pendingContentRestore) return;
        scrollMemoryPath = pendingContentRestore.path;
        pendingContentRestore = null;
        rememberContentScroll();
        schedulePersistTabs();
    };
    content.addEventListener('pointerdown', cancelRestore);
    content.addEventListener('wheel', cancelRestore);
    content.addEventListener('touchstart', cancelRestore);
    document.addEventListener('keydown', event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelRestore();
    });
    content.addEventListener('scroll', () => {
        if (rememberContentScroll()) schedulePersistTabs();
    });
}

function setupLightbox() {
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('img01');
    const captionText = document.getElementById('caption');
    const close = modal.querySelector('.close');

    const hide = () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
        lastFocusedElement?.focus?.();
    };
    close.addEventListener('click', hide);
    modal.addEventListener('click', event => { if (event.target === modal) hide(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && modal.style.display === 'block') hide(); });

    window.openImageModal = (image, label) => {
        lastFocusedElement = document.activeElement;
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
        modalImg.src = image;
        modalImg.alt = label || '';
        captionText.textContent = label || '';
        close.focus();
    };
}

function attachImageListeners() {
    document.querySelectorAll('#markdown-content img').forEach(image => {
        image.tabIndex = 0;
        image.setAttribute('role', 'button');
        const open = () => window.openImageModal(image.currentSrc || image.src, image.alt);
        image.onclick = open;
        image.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
    });
}

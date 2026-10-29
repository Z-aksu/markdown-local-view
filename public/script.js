let allTreeItems = []; // Store flattened tree for easy searching
const tabs = new Map();
const tabElements = new Map();
const TABS_STORAGE_KEY = 'markdown-view.tabs.v1';
const SIDEBAR_STORAGE_KEY = 'markdown-view.sidebar-collapsed.v1';
let activePath = null;
let persistTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    // Start fetching tree immediately
    const treePromise = fetchFileTree();
    
    restoreTabs();
    setupResizer();
    setupSidebar();
    setupLightbox();
    setupSearch();
    setupTabs();
    setupContentScrollMemory();
    renderTabs();
    
    // Wait for tree to render before handling hash (so we can highlight)
    const tree = await treePromise;
    const availablePaths = tree ? removeMissingTabs(tree) : null;

    if (availablePaths && window.location.hash) {
        const hashPath = decodeURIComponent(window.location.hash.slice(1));
        if (!availablePaths.has(hashPath)) {
            window.location.hash = activePath || '';
            if (!activePath) handleHashChange();
            return;
        }
    }
    
    // Check for initial hash, falling back to the persisted active tab.
    if (!window.location.hash && activePath) {
        window.location.hash = activePath;
    } else {
        handleHashChange();
    }
});

window.addEventListener('beforeunload', persistTabs);

// Listen for hash changes
window.addEventListener('hashchange', handleHashChange);

function handleHashChange() {
    const hash = window.location.hash.slice(1); // Remove '#'
    if (hash) {
        const path = decodeURIComponent(hash);
        activateTab(path);
        highlightTreeItem(path);
    } else {
        activePath = null;
        persistTabs();
        document.getElementById('markdown-content').innerHTML = `
            <h1>Select a file to view</h1>
            <p>Choose a document from the sidebar to start reading.</p>
        `;
        renderTabs();
        document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
    }
}

function setupSidebar() {
    const container = document.querySelector('.container');
    const sidebar = document.getElementById('sidebar');
    const collapseButton = document.getElementById('sidebar-toggle');
    const expandButton = document.getElementById('content-sidebar-toggle');
    const mobileButton = document.getElementById('mobile-menu-toggle');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!container || !sidebar) return;

    const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
    let collapsed = isMobile();
    try {
        if (!isMobile()) collapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
    } catch (_) { /* localStorage may be unavailable */ }

    const setCollapsed = (next) => {
        collapsed = Boolean(next);
        container.classList.toggle('sidebar-collapsed', collapsed);
        const expanded = !collapsed;
        [collapseButton, expandButton].forEach(button => {
            if (!button) return;
            button.setAttribute('aria-expanded', String(expanded));
        });
        if (collapseButton) collapseButton.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        if (mobileButton) {
            mobileButton.setAttribute('aria-expanded', String(expanded));
            mobileButton.setAttribute('aria-label', expanded ? 'Close document menu' : 'Open document menu');
        }
        if (!isMobile()) {
            try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed)); } catch (_) { /* ignore */ }
        }
    };

    collapseButton?.addEventListener('click', () => setCollapsed(true));
    expandButton?.addEventListener('click', () => setCollapsed(false));
    mobileButton?.addEventListener('click', () => setCollapsed(!collapsed));
    backdrop?.addEventListener('click', () => setCollapsed(true));
    window.addEventListener('resize', () => {
        if (isMobile() && !container.classList.contains('sidebar-collapsed')) setCollapsed(true);
    });
    setCollapsed(collapsed);
}

function activateTab(path) {
    const existingTab = tabs.get(path);
    if (existingTab) {
        activePath = path;
        renderTabs();
        renderTabContent(existingTab);
        if (existingTab.loading && !existingTab.requested) {
            existingTab.requested = true;
            loadContent(existingTab);
        }
        schedulePersistTabs();
        return;
    }

    const tab = {
        path,
        title: path.split('/').pop(),
        html: null,
        scrollTop: 0,
        loading: true,
        requested: true
    };
    tabs.set(path, tab);
    activePath = path;
    renderTabs();
    renderTabContent(tab);
    schedulePersistTabs();
    loadContent(tab);
}

function restoreTabs() {
    try {
        const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) || 'null');
        if (!saved || !Array.isArray(saved.tabs)) return;

        saved.tabs.forEach(item => {
            if (!item || typeof item.path !== 'string' || !item.path) return;
            if (tabs.has(item.path)) return;
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

        if (typeof saved.activePath === 'string' && tabs.has(saved.activePath)) {
            activePath = saved.activePath;
        } else if (tabs.size > 0) {
            const paths = Array.from(tabs.keys());
            activePath = paths[paths.length - 1];
        }
    } catch (error) {
        console.warn('Unable to restore open tabs:', error);
    }
}

function removeMissingTabs(items) {
    const availablePaths = new Set();
    const collectPaths = treeItems => {
        treeItems.forEach(item => {
            if (item.type === 'file' && item.path) availablePaths.add(item.path);
            if (Array.isArray(item.children)) collectPaths(item.children);
        });
    };
    collectPaths(items);

    tabs.forEach((_tab, path) => {
        if (!availablePaths.has(path)) tabs.delete(path);
    });

    if (!tabs.has(activePath)) {
        const remainingPaths = Array.from(tabs.keys());
        activePath = remainingPaths[remainingPaths.length - 1] || null;
    }

    renderTabs();
    persistTabs();
    return availablePaths;
}

function persistTabs() {
    persistTimer = null;
    try {
        localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
            activePath,
            tabs: Array.from(tabs.values()).map(tab => ({
                path: tab.path,
                scrollTop: Number.isFinite(tab.scrollTop) ? tab.scrollTop : 0
            }))
        }));
    } catch (error) {
        console.warn('Unable to persist open tabs:', error);
    }
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
            tabElement.appendChild(title);

            const close = document.createElement('button');
            close.className = 'tab-close';
            close.type = 'button';
            close.setAttribute('aria-label', `Close ${tab.title}`);
            close.textContent = '×';
            tabElement.appendChild(close);

            tabElements.set(tab.path, tabElement);
        }

        tabElement.classList.toggle('active', tab.path === activePath);
        tabElement.setAttribute('aria-selected', tab.path === activePath ? 'true' : 'false');
        tabElement.title = tab.path;
        tabElement.querySelector('.tab-title').textContent = tab.title;
        tabsContainer.appendChild(tabElement);
        renderedPaths.add(tab.path);
    });

    tabElements.forEach((element, path) => {
        if (!renderedPaths.has(path)) {
            element.remove();
            tabElements.delete(path);
        }
    });
}

function setupTabs() {
    const tabsContainer = document.getElementById('tabs');
    tabsContainer.addEventListener('click', event => {
        const tabElement = event.target.closest('.tab');
        if (!tabElement) return;

        const path = tabElement.dataset.path;
        if (event.target.closest('.tab-close')) {
            closeTab(path);
            return;
        }

        if (window.location.hash.slice(1) !== encodeURIComponent(path)) {
            window.location.hash = path;
        } else {
            activateTab(path);
        }
    });
}

function renderTabContent(tab) {
    const contentDiv = document.getElementById('markdown-content');
    contentDiv.innerHTML = tab.loading ? '<p>Loading...</p>' : tab.html;
    renderMath(contentDiv);
    attachImageListeners();
    requestAnimationFrame(() => {
        const content = document.querySelector('.content');
        content.scrollTop = tab.scrollTop || 0;
    });
}

function renderMath(contentDiv) {
    prepareUndelimitedMath(contentDiv);
    if (typeof renderMathInElement !== 'function') return;

    renderMathInElement(contentDiv, {
        throwOnError: false,
        strict: 'ignore',
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false }
        ]
    });
}

// Some existing notes use plain parenthesized LaTeX instead of $...$ delimiters.
// Add delimiters only when a balanced parenthesized segment contains clear LaTeX
// commands, leaving normal prose and code untouched.
function prepareUndelimitedMath(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    textNodes.forEach(textNode => {
        if (textNode.parentElement.closest('code, pre, .katex')) return;
        const original = textNode.nodeValue;
        let transformed = original.replace(/\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}/g, (match, _environment, offset, source) => {
            const before = source.slice(0, offset);
            const after = source.slice(offset + match.length);
            const normalizedMatch = normalizeEnvironmentLineBreaks(match);
            return before.endsWith('$$') && after.startsWith('$$') ? normalizedMatch : `$$${normalizedMatch}$$`;
        });
        transformed = wrapParenthesizedMath(transformed);
        if (transformed !== original) textNode.nodeValue = transformed;
    });
}

function normalizeEnvironmentLineBreaks(math) {
    // Markdown may leave a single backslash for a row break ("\\ S_n").
    // KaTeX requires two backslashes inside cases/align-style environments.
    return math.replace(/\\(?!\\)(?=\s+)/g, '\\\\');
}

function wrapParenthesizedMath(text) {
    let result = '';
    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf('(', cursor);
        if (start === -1) return result + text.slice(cursor);

        let depth = 0;
        let end = -1;
        for (let index = start; index < text.length; index += 1) {
            if (text[index] === '(') depth += 1;
            if (text[index] === ')') {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }

        if (end === -1) return result + text.slice(cursor);
        const segment = text.slice(start + 1, end);
        const containsDisplayMath = segment.includes('$$');
        const hasLatex = containsDisplayMath || /\\[a-zA-Z]+|[_^](?:\{[^}]+\}|[A-Za-z0-9])/.test(segment);
        result += text.slice(cursor, start);
        if (containsDisplayMath) {
            result += `$$${segment.replace(/\$\$/g, '').trim()}$$`;
        } else {
            result += hasLatex ? `\\(${segment}\\)` : text.slice(start, end + 1);
        }
        cursor = end + 1;
    }
    return result;
}

function closeTab(path) {
    const wasActive = activePath === path;
    tabs.delete(path);
    tabElements.get(path)?.remove();
    tabElements.delete(path);
    schedulePersistTabs();
    if (!wasActive) {
        renderTabs();
        return;
    }

    const remaining = Array.from(tabs.keys());
    const nextPath = remaining[remaining.length - 1];
    window.location.hash = nextPath || '';
}

async function fetchFileTree() {
    try {
        const response = await fetch('/api/tree');
        const tree = await response.json();
        const treeContainer = document.getElementById('file-tree');
        renderTree(tree, treeContainer);
        return tree;
    } catch (error) {
        console.error('Error fetching file tree:', error);
        document.getElementById('file-tree').innerText = 'Error loading file tree.';
        return null;
    }
}

function renderTree(items, container) {
    if (!items || items.length === 0) {
        container.innerHTML = '<div style="color: #666; font-style: italic;">No markdown files found</div>';
        return;
    }

    // Sort: Directories first, then files
    items.sort((a, b) => {
        const aName = a.name;
        const bName = b.name;
        
        // Extract leading numbers
        const aMatch = aName.match(/^(\d+)/);
        const bMatch = bName.match(/^(\d+)/);
        
        // If both start with numbers, sort by number
        if (aMatch && bMatch) {
            const aNum = parseInt(aMatch[1], 10);
            const bNum = parseInt(bMatch[1], 10);
            
            if (aNum !== bNum) {
                return aNum - bNum;
            }
            // If numbers are equal, fall back to natural sort
            return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
        }
        
        // If only one starts with a number, prioritize it? 
        // Assuming numbered items should come first (overriding directory/file type)
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;

        // Fallback: Directories first, then alphabetical
        if (a.type === b.type) {
            return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
        }
        return a.type === 'directory' ? -1 : 1;
    });

    items.forEach(item => {
        // Filter out 'images' directory
        if (item.type === 'directory' && item.name.toLowerCase() === 'images') {
            return;
        }

        const itemDiv = document.createElement('div');
        itemDiv.className = `tree-item ${item.type}`;
        // Store name for search and path for routing
        itemDiv.dataset.name = item.name.toLowerCase();
        if (item.path) {
            itemDiv.dataset.path = item.path;
        }
        
        const nameSpan = document.createElement('div');
        nameSpan.className = 'item-name';
        nameSpan.title = item.name; // Tooltip for long names
        nameSpan.innerHTML = `<span class="icon">${item.type === 'directory' ? '📁' : '📄'}</span><span class="item-text">${item.name}</span>`;
        itemDiv.appendChild(nameSpan);

        if (item.type === 'directory') {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'children';
            itemDiv.appendChild(childrenContainer);

            // Recursively render children
            if (item.children && item.children.length > 0) {
                renderTree(item.children, childrenContainer);
            } else {
                childrenContainer.innerHTML = '<div style="padding-left: 20px; color: #999; font-size: 0.9em;">(empty)</div>';
            }

            // Toggle directory
            nameSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDirectory(childrenContainer, nameSpan);
            });
        } else {
            // File click
            nameSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                // Update URL hash - this triggers hashchange event which calls loadContent
                window.location.hash = item.path;
            });
        }

        container.appendChild(itemDiv);
    });
}

function toggleDirectory(childrenContainer, nameSpan) {
    childrenContainer.classList.toggle('expanded');
    const icon = nameSpan.querySelector('.icon');
    if (icon) {
        icon.textContent = childrenContainer.classList.contains('expanded') ? '📂' : '📁';
    }
}

function highlightTreeItem(path) {
    // Remove active class from all
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));

    // Find the item with the matching path
    const items = Array.from(document.querySelectorAll('.tree-item.file'));
    const targetItem = items.find(item => item.dataset.path === path);

    if (targetItem) {
        targetItem.classList.add('active');
        
        // Expand all parent directories
        let parent = targetItem.parentElement; // container
        while (parent) {
            if (parent.classList.contains('children')) {
                parent.classList.add('expanded');
                // Update icon of the directory
                const dirItem = parent.parentElement; // the .tree-item.directory
                if (dirItem) {
                    const icon = dirItem.querySelector('.item-name .icon');
                    if (icon) icon.textContent = '📂';
                }
            }
            parent = parent.parentElement;
            if (parent.id === 'file-tree') break;
        }
        
        // Scroll into view if needed
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

async function loadContent(tab) {
    try {
        const response = await fetch(`/api/content?path=${encodeURIComponent(tab.path)}`);
        if (!response.ok) throw new Error('Failed to load content');
        
        const data = await response.json();
        tab.html = data.html;
        tab.loading = false;
        if (activePath === tab.path) renderTabContent(tab);
    } catch (error) {
        console.error('Error loading content:', error);
        tab.html = '<p style="color: red;">Error loading file content.</p>';
        tab.loading = false;
        if (activePath === tab.path) renderTabContent(tab);
    }
}

// Search Logic
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    let searchFrame = null;
    
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        if (searchFrame !== null) cancelAnimationFrame(searchFrame);
        searchFrame = requestAnimationFrame(() => {
            searchFrame = null;
            const treeRoot = document.getElementById('file-tree');

            if (!query) {
                // Show all and collapse all if query is empty
                resetTree(treeRoot);
                return;
            }

            filterTree(treeRoot, query);
        });
    });
}

function filterTree(container, query) {
    const items = container.children;
    let hasMatch = false;

    for (let item of items) {
        if (!item.classList.contains('tree-item')) continue;

        const name = item.dataset.name;
        const isDir = item.classList.contains('directory');
        let childMatch = false;

        if (isDir) {
            const childrenContainer = item.querySelector('.children');
            if (childrenContainer) {
                childMatch = filterTree(childrenContainer, query);
            }
        }

        const selfMatch = name.includes(query);

        if (selfMatch || childMatch) {
            item.style.display = 'block';
            hasMatch = true;
            
            // Expand directory if children match
            if (isDir && childMatch) {
                const childrenContainer = item.querySelector('.children');
                const nameSpan = item.querySelector('.item-name');
                if (childrenContainer && !childrenContainer.classList.contains('expanded')) {
                    toggleDirectory(childrenContainer, nameSpan);
                }
            }
        } else {
            item.style.display = 'none';
        }
    }

    return hasMatch;
}

function resetTree(container) {
    const items = container.querySelectorAll('.tree-item');
    items.forEach(item => {
        item.style.display = 'block';
        if (item.classList.contains('directory')) {
            const childrenContainer = item.querySelector('.children');
            childrenContainer.classList.remove('expanded');
            const icon = item.querySelector('.icon');
            if (icon) icon.textContent = '📁';
        }
    });
}


// Resizer Logic
function setupResizer() {
    const sidebar = document.querySelector('.sidebar');
    const resizer = document.getElementById('drag-resizer');
    
    if (!resizer || !sidebar) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        resizer.classList.add('resizing');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        // Prevent selecting text while resizing
        e.preventDefault();

        // Calculate new width
        let newWidth = e.clientX;
        
        // Min width constraint (must match CSS min-width)
        if (newWidth < 150) newWidth = 150;
        
        // Max width constraint (optional, e.g., 50% of viewport)
        if (newWidth > window.innerWidth * 0.5) newWidth = window.innerWidth * 0.5;

        sidebar.style.width = `${newWidth}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = 'default';
            resizer.classList.remove('resizing');
        }
    });
}

function setupContentScrollMemory() {
    const content = document.querySelector('.content');
    let scrollFrame = null;
    content.addEventListener('scroll', () => {
        if (!activePath || scrollFrame !== null) return;
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = null;
            const tab = tabs.get(activePath);
            if (tab) {
                tab.scrollTop = content.scrollTop;
                schedulePersistTabs();
            }
        });
    });
}

// Lightbox Logic
function setupLightbox() {
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('img01');
    const captionText = document.getElementById('caption');
    const span = document.getElementsByClassName('close')[0];

    // Close when clicking the 'x'
    span.onclick = function() { 
        modal.style.display = 'none';
    }

    // Close when clicking outside the image
    modal.onclick = function(e) {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    }
}

function attachImageListeners() {
    const images = document.querySelectorAll('#markdown-content img');
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('img01');
    const captionText = document.getElementById('caption');

    images.forEach(img => {
        img.onclick = function(){
            modal.style.display = 'block';
            modalImg.src = this.src;
            captionText.innerHTML = this.alt;
        }
    });
}

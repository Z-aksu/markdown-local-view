const express = require('express');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { marked } = require('marked');
const open = require('open');

const PUBLIC_PATH = path.join(__dirname, '../public');
const KATEX_PATH = path.join(__dirname, '../node_modules/katex/dist');
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn']);
const MATH_MARKER_START = '\uE000mdview-math-';
const MATH_MARKER_END = '\uE001';

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function isMarkdownFile(fileName) {
    return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isWithinRoot(rootPath, candidatePath, allowRoot = false) {
    const relative = path.relative(rootPath, candidatePath);
    if (relative === '') return allowRoot;
    return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveWithinRoot(rootPath, requestPath) {
    if (typeof requestPath !== 'string' || !requestPath.trim()) return null;

    // URLs use forward slashes. A leading slash is treated as root-relative to the
    // selected document directory, while drive-qualified paths remain outside.
    const relativeRequest = requestPath.replace(/^[/\\]+/, '');
    const candidate = path.resolve(rootPath, relativeRequest);
    return isWithinRoot(rootPath, candidate) ? candidate : null;
}

function encodeAssetPath(assetPath) {
    return assetPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function splitHref(href) {
    const value = String(href || '');
    const match = value.match(/^([^?#]*)([?#][\s\S]*)?$/);
    return {
        pathname: match ? match[1] : value,
        suffix: match?.[2] || ''
    };
}

function splitSuffix(suffix) {
    const hashIndex = suffix.indexOf('#');
    if (hashIndex === -1) return { query: suffix, hash: '' };
    return { query: suffix.slice(0, hashIndex), hash: suffix.slice(hashIndex) };
}

function resolveDocumentPath(documentPath, hrefPath) {
    const normalizedHref = hrefPath.replace(/\\/g, '/');
    const baseDir = path.posix.dirname(toPosixPath(documentPath));
    const joined = normalizedHref.startsWith('/')
        ? path.posix.normalize(normalizedHref.slice(1))
        : path.posix.normalize(path.posix.join(baseDir, normalizedHref));

    if (!joined || joined === '.' || joined === '..' || joined.startsWith('../') || joined.startsWith('/')) {
        return null;
    }
    return joined;
}

function isUnsafeProtocol(href) {
    return /^\s*(?:javascript|vbscript|data):/i.test(String(href || ''));
}

function isExternalHref(href) {
    return /^(?:https?:|mailto:|tel:|\/\/)/i.test(String(href || ''));
}

function isMarkdownPath(filePath) {
    return isMarkdownFile(filePath);
}

function createMarkdownRenderer(documentPath) {
    const renderer = new marked.Renderer();
    const originalImage = renderer.image.bind(renderer);
    renderer.html = token => escapeHtml(token.raw ?? token.text ?? '');
    const originalLink = renderer.link.bind(renderer);
    const usedHeadingIds = new Set();

    renderer.image = token => {
        const { href } = token;
        if (!href || isUnsafeProtocol(href)) return '';
        if (isExternalHref(href)) return originalImage(token);

        const { pathname, suffix } = splitHref(href);
        if (!pathname) return originalImage(token);
        const assetPath = resolveDocumentPath(documentPath, pathname);
        if (!assetPath) return '';

        return originalImage({ ...token, href: `/assets/${encodeAssetPath(assetPath)}${suffix}` });
    };

    renderer.link = token => {
        const { href } = token;
        if (!href || isUnsafeProtocol(href)) return token.text || '';
        if (href.startsWith('#') || isExternalHref(href)) return originalLink(token);

        const { pathname, suffix } = splitHref(href);
        if (!pathname) return originalLink(token);

        let decodedPath = pathname;
        try {
            decodedPath = decodeURIComponent(pathname);
        } catch (_) {
            // Keep the original value when a document contains a malformed escape.
        }

        const documentTarget = resolveDocumentPath(documentPath, decodedPath);
        if (!documentTarget) return token.text || '';

        const { hash } = splitSuffix(suffix);
        if (isMarkdownPath(documentTarget)) {
            const anchor = hash ? `#${encodeURIComponent(hash.slice(1))}` : '';
            return originalLink({
                ...token,
                href: `#file/${encodeURIComponent(documentTarget)}${anchor}`
            });
        }

        return originalLink({
            ...token,
            href: `/assets/${encodeAssetPath(documentTarget)}${suffix}`
        });
    };

    renderer.heading = ({ text, depth }) => {
        const safeText = sanitizeInlineHtml(text);
        const baseId = slugifyHeading(safeText) || 'section';
        let id = baseId;
        let suffix = 1;
        while (usedHeadingIds.has(id)) id = `${baseId}-${suffix++}`;
        usedHeadingIds.add(id);
        return `<h${depth} id="${id}">${safeText}</h${depth}>\n`;
    };

    return renderer;
}

function sanitizeInlineHtml(value) {
    return String(value).replace(/<([^>]+)>/g, (match, inner) => {
        if (/^\s*\/?\s*(?:script|style|iframe|object|embed|svg|math|base|meta|link)(?:\s|$)/i.test(inner)) {
            return escapeHtml(match);
        }
        if (/\bon[a-z]+\s*=|(?:href|src)\s*=\s*['\"]?\s*(?:javascript|vbscript|data):/i.test(inner)) {
            return escapeHtml(match);
        }
        return match;
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function slugifyHeading(value) {
    const withoutTags = String(value)
        .replace(/<[^>]*>/g, '')
        .replace(/&(?:amp|lt|gt|quot|#39);/gi, ' ')
        .replace(/[\uE000-\uE001][^\uE001]*\uE001/g, ' ')
        .normalize('NFKC')
        .toLocaleLowerCase();

    return withoutTags
        .replace(/[^\p{L}\p{N}\-_\s]/gu, '')
        .trim()
        .replace(/\s+/g, '-');
}

function isEscaped(source, index) {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashCount += 1;
    return slashCount % 2 === 1;
}

function findUnescaped(source, delimiter, start) {
    for (let cursor = start; cursor <= source.length - delimiter.length; cursor += 1) {
        if (source.startsWith(delimiter, cursor) && !isEscaped(source, cursor)) return cursor;
    }
    return -1;
}

function readFencedCode(source, start) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (!/^[ \t]{0,3}$/.test(source.slice(lineStart, start))) return null;

    const opener = source.slice(start).match(/^(`{3,}|~{3,})[^\n]*(?:\n|$)/);
    if (!opener) return null;

    const fence = opener[1];
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`, 'm');
    const bodyStart = start + opener[0].length;
    const closingMatch = closing.exec(source.slice(bodyStart));
    const end = closingMatch
        ? bodyStart + closingMatch.index + closingMatch[0].length
        : source.length;

    return { end, value: source.slice(start, end) };
}

function readInlineCode(source, start) {
    const run = source.slice(start).match(/^`+/)?.[0];
    if (!run) return null;
    const end = source.indexOf(run, start + run.length);
    return {
        end: end === -1 ? source.length : end + run.length,
        value: source.slice(start, end === -1 ? source.length : end + run.length)
    };
}

function readMath(source, start) {
    if (isEscaped(source, start)) return null;

    const candidates = source.startsWith('$$', start)
        ? [{ open: '$$', close: '$$' }]
        : source.startsWith('\\[', start)
            ? [{ open: '\\[', close: '\\]' }]
            : source.startsWith('\\(', start)
                ? [{ open: '\\(', close: '\\)' }]
                : source[start] === '$' && source[start + 1] !== '$'
                    ? [{ open: '$', close: '$' }]
                    : [];

    for (const candidate of candidates) {
        const closeIndex = findUnescaped(source, candidate.close, start + candidate.open.length);
        if (closeIndex === -1) continue;
        if (candidate.open === '$') {
            const body = source.slice(start + 1, closeIndex);
            if (body.includes('\n') || /^\s|\s$/.test(body)) continue;
        }
        const end = closeIndex + candidate.close.length;
        return { end, value: source.slice(start, end) };
    }

    return null;
}

// Protect math before Marked parses Markdown. Otherwise underscores, backslashes,
// ampersands, and environment line breaks can be consumed by Markdown parsing.
function protectMath(source) {
    const tokens = [];
    let output = '';
    let cursor = 0;

    const addToken = value => {
        const marker = `${MATH_MARKER_START}${tokens.length}${MATH_MARKER_END}`;
        tokens.push(value);
        output += marker;
    };

    while (cursor < source.length) {
        const fencedCode = readFencedCode(source, cursor);
        if (fencedCode) {
            output += fencedCode.value;
            cursor = fencedCode.end;
            continue;
        }

        if (source[cursor] === '`') {
            const inlineCode = readInlineCode(source, cursor);
            output += inlineCode.value;
            cursor = inlineCode.end;
            continue;
        }

        const math = readMath(source, cursor);
        if (math) {
            addToken(math.value);
            cursor = math.end;
            continue;
        }

        output += source[cursor];
        cursor += 1;
    }

    return { source: output, tokens };
}


function restoreMath(html, tokens) {
    return tokens.reduce((result, value, index) => {
        const marker = `${MATH_MARKER_START}${index}${MATH_MARKER_END}`;
        return result.split(marker).join(escapeHtml(value));
    }, html);
}

function renderMarkdown(content, documentPath) {
    const normalizedContent = String(content).replace(/^\uFEFF/, '');
    const protectedMath = protectMath(normalizedContent);
    const html = marked(protectedMath.source, {
        gfm: true,
        breaks: false,
        pedantic: false,
        renderer: createMarkdownRenderer(documentPath)
    });
    return restoreMath(html, protectedMath.tokens);
}

// Helper to get file tree. Directories without Markdown descendants are omitted,
// which keeps asset-only folders from cluttering the document navigator.
async function getFileTree(dir, baseDir = dir, rootDir = baseDir, visited = new Set()) {
    const rootRealPath = await fs.realpath(rootDir);
    const realDir = await fs.realpath(dir);
    if (!isWithinRoot(rootRealPath, realDir, true) || visited.has(realDir)) return [];
    visited.add(realDir);

    const items = await fs.readdir(dir, { withFileTypes: true });
    const tree = [];

    for (const item of items) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;

        const fullPath = path.join(dir, item.name);
        const relativePath = toPosixPath(path.relative(baseDir, fullPath));

        if (item.isDirectory()) {
            const children = await getFileTree(fullPath, baseDir, rootDir, visited);
            if (children.length > 0) {
                tree.push({ name: item.name, path: relativePath, type: 'directory', children });
            }
        } else if (item.isFile() && isMarkdownFile(item.name)) {
            tree.push({ name: item.name, path: relativePath, type: 'file' });
        }
    }

    return tree;
}

function normalizePort(port) {
    const normalizedPort = Number(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
        throw new Error(`Invalid port: ${port}. Expected an integer between 1 and 65535.`);
    }
    return normalizedPort;
}

function tryListen(app, port, host) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host);

        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server);
        };

        const onError = error => {
            server.removeListener('listening', onListening);
            server.close(() => {
                if (error.code === 'EADDRINUSE') resolve(null);
                else reject(error);
            });
        };

        server.once('listening', onListening);
        server.once('error', onError);
    });
}

async function listenWithFallback(app, startPort, host, maxAttempts = 20) {
    for (let offset = 0; offset < maxAttempts; offset += 1) {
        const port = startPort + offset;
        if (port > 65535) break;
        const server = await tryListen(app, port, host);
        if (server) return { server, port };
        console.warn(`Port ${port} is already in use; trying port ${port + 1}.`);
    }

    const lastPort = Math.min(65535, startPort + maxAttempts - 1);
    throw new Error(`Unable to find an available port from ${startPort} to ${lastPort}.`);
}

function getLanAddresses() {
    const addresses = [];
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const address of interfaces || []) {
            if (address.internal) continue;
            if (address.family !== 'IPv4' && address.family !== 4) continue;
            addresses.push(address.address);
        }
    }
    return [...new Set(addresses)];
}

function createApp(targetDir = process.cwd()) {
    const rootPath = path.resolve(targetDir);
    const app = express();

    app.use(express.static(PUBLIC_PATH));
    app.use('/vendor/katex', express.static(KATEX_PATH));

    // Keep asset URLs relative to the selected directory, including for paths
    // containing encoded separators or symlinks.
    app.use('/assets', async (req, res, next) => {
        let requestPath;
        try {
            requestPath = decodeURIComponent(req.path).replace(/^[/\\]+/, '');
        } catch (_) {
            return res.status(400).end();
        }

        const candidate = resolveWithinRoot(rootPath, requestPath);
        if (!candidate) return res.status(403).json({ error: 'Access denied' });

        try {
            const [rootRealPath, candidateRealPath] = await Promise.all([
                fs.realpath(rootPath),
                fs.realpath(candidate)
            ]);
            if (!isWithinRoot(rootRealPath, candidateRealPath)) {
                return res.status(403).json({ error: 'Access denied' });
            }
        } catch (_) {
            // Let express.static produce the normal 404 for missing assets.
        }

        return next();
    }, express.static(rootPath, { dotfiles: 'deny', index: false }));

    app.get('/api/tree', async (_req, res) => {
        try {
            const tree = await getFileTree(rootPath, rootPath, rootPath);
            res.json(tree);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Failed to scan directory' });
        }
    });

    app.get('/api/content', async (req, res) => {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'Path is required' });

        const fullPath = resolveWithinRoot(rootPath, filePath);
        if (!fullPath) return res.status(403).json({ error: 'Access denied' });

        try {
            const [rootRealPath, fileRealPath] = await Promise.all([
                fs.realpath(rootPath),
                fs.realpath(fullPath)
            ]);
            if (!isWithinRoot(rootRealPath, fileRealPath)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const stat = await fs.stat(fileRealPath);
            if (!stat.isFile() || !isMarkdownFile(fileRealPath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            const content = await fs.readFile(fileRealPath, 'utf8');
            const html = renderMarkdown(content, toPosixPath(path.relative(rootRealPath, fileRealPath)));
            return res.json({ html });
        } catch (error) {
            console.error(error);
            return res.status(404).json({ error: 'File not found' });
        }
    });

    return app;
}

async function startServer(port = 51221, targetDir = process.cwd(), host = '0.0.0.0') {
    let requestedPort;
    try {
        requestedPort = normalizePort(port);
    } catch (error) {
        console.error(`Could not start Markdown Server: ${error.message}`);
        process.exitCode = 1;
        return null;
    }

    const app = createApp(targetDir);

    try {
        const { port: actualPort } = await listenWithFallback(app, requestedPort, host);
        const localUrl = `http://localhost:${actualPort}`;
        console.log(`Markdown Server running at ${localUrl}`);
        if (host === '0.0.0.0' || host === '::') {
            for (const address of getLanAddresses()) console.log(`LAN access: http://${address}:${actualPort}`);
        }
        console.log(`Serving files from: ${path.resolve(targetDir)}`);
        open(localUrl).catch(error => {
            console.warn(`Could not open the browser automatically: ${error.message}`);
        });
        return actualPort;
    } catch (error) {
        console.error(`Could not start Markdown Server: ${error.message}`);
        process.exitCode = 1;
        return null;
    }
}

module.exports = {
    createApp,
    getFileTree,
    isMarkdownFile,
    protectMath,
    renderMarkdown,
    startServer
};

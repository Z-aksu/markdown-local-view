const express = require('express');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { marked } = require('marked');
const open = require('open');

const app = express();

// Helper to get file tree
async function getFileTree(dir, baseDir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const tree = [];

    for (const item of items) {
        if (item.name.startsWith('.')) continue; // Skip hidden files

        const fullPath = path.join(dir, item.name);
        const relativePath = path.relative(baseDir, fullPath);

        if (item.isDirectory()) {
            tree.push({
                name: item.name,
                path: relativePath,
                type: 'directory',
                children: await getFileTree(fullPath, baseDir)
            });
        } else if (item.name.endsWith('.md')) {
            tree.push({
                name: item.name,
                path: relativePath,
                type: 'file'
            });
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

function tryListen(port, host) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host);

        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server);
        };

        const onError = (error) => {
            server.removeListener('listening', onListening);
            server.close(() => {
                if (error.code === 'EADDRINUSE') {
                    resolve(null);
                } else {
                    reject(error);
                }
            });
        };

        server.once('listening', onListening);
        server.once('error', onError);
    });
}

async function listenWithFallback(startPort, host, maxAttempts = 20) {
    for (let offset = 0; offset < maxAttempts; offset += 1) {
        const port = startPort + offset;
        if (port > 65535) break;
        const server = await tryListen(port, host);
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

async function startServer(port = 3590, targetDir = process.cwd(), host = '0.0.0.0') {
    let requestedPort;
    try {
        requestedPort = normalizePort(port);
    } catch (error) {
        console.error(`Could not start Markdown Server: ${error.message}`);
        process.exitCode = 1;
        return null;
    }

    // Serve static frontend files
    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath));
    // Serve KaTeX locally so math rendering works without an external CDN.
    app.use('/vendor/katex', express.static(path.join(__dirname, '../node_modules/katex/dist')));

    // Serve user's files as assets
    // We use /assets prefix to avoid conflicts with frontend files
    app.use('/assets', express.static(targetDir));

    // API to get file tree
    app.get('/api/tree', async (req, res) => {
        try {
            const tree = await getFileTree(targetDir, targetDir);
            res.json(tree);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Failed to scan directory' });
        }
    });

    // API to get markdown content
    app.get('/api/content', async (req, res) => {
        const filePath = req.query.path;
        if (!filePath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Security check: prevent directory traversal
        const fullPath = path.resolve(targetDir, filePath);
        if (!fullPath.startsWith(path.resolve(targetDir))) {
             return res.status(403).json({ error: 'Access denied' });
        }

        try {
            const content = await fs.readFile(fullPath, 'utf-8');
            
            // Configure marked renderer to rewrite image URLs
            const renderer = new marked.Renderer();
            const originalImage = renderer.image.bind(renderer);
            
            renderer.image = ({href, title, text}) => {
                // If the link is absolute (http/https) or starts with /, leave it alone
                // (Assuming / starts from root of website, which might be tricky, 
                // but usually relative paths are ./ or just filename)
                if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
                    return originalImage({href, title, text});
                }
                
                // If it starts with /, treat it as relative to the targetDir root
                // We map targetDir to /assets
                if (href.startsWith('/')) {
                    const newHref = `/assets${href}`;
                     return originalImage({href: newHref, title, text});
                }

                // Relative path logic
                // filePath is like "subdir/image_test.md"
                // dirPath is "subdir"
                const dirPath = path.dirname(filePath);
                
                // Construct the new path: /assets/subdir/pic.png
                // Use forward slashes for URL
                let relativeUrl = path.join(dirPath, href).split(path.sep).join('/');
                
                // Ensure no double slashes if dirPath is empty (root)
                if (relativeUrl.startsWith('/')) relativeUrl = relativeUrl.substring(1);
                
                const newHref = `/assets/${relativeUrl}`;
                return originalImage({href: newHref, title, text});
            };

            // Typora (and many Markdown editors) render a single source newline
            // as a visible line break.  Browsers collapse those newlines when
            // they are emitted as plain text inside a paragraph, so opt in to
            // marked's soft-break handling to preserve the author's formatting.
            const html = marked(content, { renderer, breaks: true });
            res.json({ html });
        } catch (error) {
            console.error(error);
            res.status(404).json({ error: 'File not found' });
        }
    });

    try {
        const { port: actualPort } = await listenWithFallback(requestedPort, host);
        const localUrl = `http://localhost:${actualPort}`;
        console.log(`Markdown Server running at ${localUrl}`);
        if (host === '0.0.0.0' || host === '::') {
            for (const address of getLanAddresses()) {
                console.log(`LAN access: http://${address}:${actualPort}`);
            }
        }
        console.log(`Serving files from: ${targetDir}`);
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

module.exports = { startServer };

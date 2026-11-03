const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp, renderMarkdown, protectMath } = require('../src/server');

async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-view-'));
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), '# Intro\n\nWelcome.');
    await fs.writeFile(path.join(root, 'docs', 'complex.md'), [
        '# Complex',
        '',
        'Inline $E = mc^2$ and \\(x_i\\).',
        '',
        '$$',
        '\\begin{aligned}',
        'a &= b \\\\',
        'c &= d',
        '\\end{aligned}',
        '$$',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '![Local image](./image.png)',
        '',
        '[README](../README.md#intro)',
        '',
        '```js',
        "const value = '$not-math$';",
        '```'
    ].join('\n'));
    await fs.writeFile(path.join(root, 'docs', 'image.png'), 'fake-image');
    return root;
}

function request(server, requestPath) {
    const address = server.address();
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: address.port, path: requestPath }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        });
        req.on('error', reject);
    });
}

test('protectMath protects explicit math and leaves code fences untouched', () => {
    const protectedValue = protectMath('Math $x_i$\n\n```js\nconst s = "$not-math$";\n```');
    assert.equal(protectedValue.tokens.length, 1);
    assert.match(protectedValue.source, /mdview-math-0/);
    assert.match(protectedValue.source, /\$not-math\$/);
});

test('renderMarkdown supports GFM, math, safe links, and heading ids', () => {
    const html = renderMarkdown([
        '# Hello world',
        '',
        '- [x] done',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        'Math $x_i$ and [unsafe](javascript:alert(1))'
    ].join('\n'), 'README.md');
    assert.match(html, /<h1 id="hello-world">/);
    assert.match(renderMarkdown('\uFEFF# BOM heading', 'README.md'), /<h1 id="bom-heading">/);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /<table>/);
    assert.match(html, /x_i/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(renderMarkdown('# <script>alert(1)</script>', 'README.md'), /<script>/i);
    assert.match(renderMarkdown('Price: $5 and $10', 'README.md'), /Price: \$5 and \$10/);
});

test('HTTP app serves tree/content/assets and rejects traversal', async t => {
    const root = await makeFixture();
    const app = createApp(root);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });

    const tree = await request(server, '/api/tree');
    assert.equal(tree.status, 200);
    assert.match(tree.body, /complex\.md/);

    const content = await request(server, '/api/content?path=docs%2Fcomplex.md');
    assert.equal(content.status, 200);
    const parsed = JSON.parse(content.body);
    assert.match(parsed.html, /mdview-math-0|E = mc/);
    assert.match(parsed.html, /type="checkbox"/);
    assert.match(parsed.html, /<table>/);
    assert.match(parsed.html, /src="\/assets\/docs\/image.png"/);
    assert.match(parsed.html, /#file\/README.md/);
    assert.match(parsed.html, /not-math/);

    const image = await request(server, '/assets/docs/image.png');
    assert.equal(image.status, 200);
    assert.equal(image.body, 'fake-image');

    const traversal = await request(server, '/api/content?path=..%2Foutside.md');
    assert.equal(traversal.status, 403);

    const assetTraversal = await request(server, '/assets/..%2Foutside.txt');
    assert.equal(assetTraversal.status, 403);
});

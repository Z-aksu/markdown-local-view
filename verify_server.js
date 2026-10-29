const http = require('http');

function makeRequest(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:3001${path}`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data); // If not JSON
                }
            });
        }).on('error', reject);
    });
}

async function test() {
    console.log('Testing /api/tree...');
    const tree = await makeRequest('/api/tree');
    console.log('Tree:', JSON.stringify(tree, null, 2));

    console.log('Testing /api/content?path=README.md...');
    const content = await makeRequest('/api/content?path=README.md');
    console.log('Content:', content);
}

test();

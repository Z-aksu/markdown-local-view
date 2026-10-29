const http = require('http');

function makeRequest(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:3002${path}`, (res) => {
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
    console.log('Testing /api/content for image_test.md...');
    // Note: Use encodeURIComponent for paths just to be safe, although test path is simple
    const content = await makeRequest('/api/content?path=subdir%2Fimage_test.md');
    console.log('Content:', JSON.stringify(content, null, 2));

    // Verify if the image src was rewritten to /assets/subdir/pic.png
    if (content.html && content.html.includes('src="/assets/subdir/pic.png"')) {
        console.log('SUCCESS: Image URL rewritten correctly.');
    } else {
        console.log('FAILURE: Image URL NOT rewritten correctly.');
    }
}

test();

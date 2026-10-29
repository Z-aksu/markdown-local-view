const markedMod = require('marked');
console.log('Type of markedMod:', typeof markedMod);
console.log('Keys:', Object.keys(markedMod));
try {
    const { marked } = require('marked');
    console.log('Type of marked destructure:', typeof marked);
    if (typeof marked === 'function') {
        console.log('marked is a function');
    } else {
        console.log('marked is NOT a function');
    }
} catch (e) {
    console.log('Error destructuring:', e.message);
}

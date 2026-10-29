
const items = [
    { name: '10. Banana', type: 'file' },
    { name: '1. Apple', type: 'file' },
    { name: '2. Cherry', type: 'file' },
    { name: 'Start', type: 'file' }
];

// Current Sort
const currentSort = [...items].sort((a, b) => a.name.localeCompare(b.name));
console.log('Current Sort:', currentSort.map(i => i.name));

// Proposed Sort
const proposedSort = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
console.log('Proposed Sort:', proposedSort.map(i => i.name));

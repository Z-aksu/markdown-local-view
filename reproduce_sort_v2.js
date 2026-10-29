
const items = [
    { name: '10. Banana', type: 'file' },
    { name: '1. Apple', type: 'file' },
    { name: '2. Cherry', type: 'directory' },
    { name: 'Start', type: 'file' },
    { name: 'Images', type: 'directory' },
    { name: 'About', type: 'file' }
];

const customSort = (a, b) => {
    const aName = a.name;
    const bName = b.name;
    
    const aMatch = aName.match(/^(\d+)/);
    const bMatch = bName.match(/^(\d+)/);
    
    if (aMatch && bMatch) {
        const aNum = parseInt(aMatch[1], 10);
        const bNum = parseInt(bMatch[1], 10);
        
        if (aNum !== bNum) {
            return aNum - bNum;
        }
        return aName.localeCompare(bName, undefined, { numeric: true });
    }
    
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;

    if (a.type === b.type) {
        return aName.localeCompare(bName, undefined, { numeric: true });
    }
    return a.type === 'directory' ? -1 : 1;
};

const sorted = [...items].sort(customSort);
console.log('Sorted:', sorted.map(i => `${i.name} (${i.type})`));

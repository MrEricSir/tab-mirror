// BiMap: bidirectional map.
// Provides lookup and insert operations in both directions. Functions that change
// one direction (set, delete, clear) are reflected in the other. 
class BiMap {
    constructor() {
        this._forward = new Map(); // A -> B
        this._reverse = new Map(); // B -> A
    }
    set(a, b) {
        // Clean up stale entries if either key was previously mapped.
        const oldB = this._forward.get(a);
        if (oldB !== undefined && oldB !== b) {
            this._reverse.delete(oldB);
        }
        const oldA = this._reverse.get(b);
        if (oldA !== undefined && oldA !== a) {
            this._forward.delete(oldA);
        }
        this._forward.set(a, b);
        this._reverse.set(b, a);
    }
    getByA(a) { return this._forward.get(a); }
    getByB(b) { return this._reverse.get(b); }
    hasA(a) { return this._forward.has(a); }
    hasB(b) { return this._reverse.has(b); }
    deleteByA(a) {
        const b = this._forward.get(a);
        if (b !== undefined) {
            this._reverse.delete(b);
        }
        this._forward.delete(a);
    }
    deleteByB(b) {
        const a = this._reverse.get(b);
        if (a !== undefined) {
            this._forward.delete(a);
        }
        this._reverse.delete(b);
    }
    clear() {
        this._forward.clear();
        this._reverse.clear();
    }
    get size() { return this._forward.size; }
    keys() { return this._forward.keys(); }
    values() { return this._forward.values(); }
    entries() { return this._forward.entries(); }
    [Symbol.iterator]() { return this._forward[Symbol.iterator](); }
    toJSON() { return Array.from(this._forward); }
}

if (typeof module !== 'undefined') {
    module.exports = { BiMap };
}

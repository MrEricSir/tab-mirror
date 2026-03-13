const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { BiMap } = require('../../src/bimap.js');

describe('BiMap', () => {
    test('set / getByA / getByB round-trip', () => {
        const bm = new BiMap();
        bm.set(1, 'sid_abc');
        assert.equal(bm.getByA(1), 'sid_abc');
        assert.equal(bm.getByB('sid_abc'), 1);
    });

    test('deleteByA removes both directions', () => {
        const bm = new BiMap();
        bm.set(1, 'sid_abc');
        bm.deleteByA(1);
        assert.equal(bm.getByA(1), undefined);
        assert.equal(bm.getByB('sid_abc'), undefined);
        assert.equal(bm.size, 0);
    });

    test('deleteByB removes both directions', () => {
        const bm = new BiMap();
        bm.set(1, 'sid_abc');
        bm.deleteByB('sid_abc');
        assert.equal(bm.getByA(1), undefined);
        assert.equal(bm.getByB('sid_abc'), undefined);
        assert.equal(bm.size, 0);
    });

    test('clear resets everything', () => {
        const bm = new BiMap();
        bm.set(1, 'a');
        bm.set(2, 'b');
        bm.set(3, 'c');
        bm.clear();
        assert.equal(bm.size, 0);
        assert.equal(bm.getByA(1), undefined);
        assert.equal(bm.getByB('a'), undefined);
    });

    test('size tracks correctly', () => {
        const bm = new BiMap();
        assert.equal(bm.size, 0);
        bm.set(1, 'a');
        assert.equal(bm.size, 1);
        bm.set(2, 'b');
        assert.equal(bm.size, 2);
        bm.deleteByA(1);
        assert.equal(bm.size, 1);
    });

    test('hasA / hasB', () => {
        const bm = new BiMap();
        bm.set(1, 'sid_abc');
        assert.equal(bm.hasA(1), true);
        assert.equal(bm.hasA(2), false);
        assert.equal(bm.hasB('sid_abc'), true);
        assert.equal(bm.hasB('sid_xyz'), false);
    });

    test('overwrite same A with different B cleans up stale B', () => {
        const bm = new BiMap();
        bm.set(1, 'old_sid');
        bm.set(1, 'new_sid');
        assert.equal(bm.getByA(1), 'new_sid');
        assert.equal(bm.getByB('new_sid'), 1);
        // Old B should be cleaned up
        assert.equal(bm.getByB('old_sid'), undefined);
        assert.equal(bm.hasB('old_sid'), false);
        assert.equal(bm.size, 1);
    });

    test('overwrite same B with different A cleans up stale A', () => {
        const bm = new BiMap();
        bm.set(1, 'sid_abc');
        bm.set(2, 'sid_abc');
        assert.equal(bm.getByB('sid_abc'), 2);
        assert.equal(bm.getByA(2), 'sid_abc');
        // Old A should be cleaned up
        assert.equal(bm.getByA(1), undefined);
        assert.equal(bm.hasA(1), false);
        assert.equal(bm.size, 1);
    });

    test('toJSON serialization', () => {
        const bm = new BiMap();
        bm.set(1, 'a');
        bm.set(2, 'b');
        const json = bm.toJSON();
        assert.deepEqual(json, [[1, 'a'], [2, 'b']]);
    });

    test('iteration (keys, values, entries, Symbol.iterator)', () => {
        const bm = new BiMap();
        bm.set(10, 'x');
        bm.set(20, 'y');

        assert.deepEqual(Array.from(bm.keys()), [10, 20]);
        assert.deepEqual(Array.from(bm.values()), ['x', 'y']);
        assert.deepEqual(Array.from(bm.entries()), [[10, 'x'], [20, 'y']]);
        assert.deepEqual(Array.from(bm), [[10, 'x'], [20, 'y']]);
    });

    test('deleteByA on non-existent key is a no-op', () => {
        const bm = new BiMap();
        bm.set(1, 'a');
        bm.deleteByA(999);
        assert.equal(bm.size, 1);
        assert.equal(bm.getByA(1), 'a');
    });

    test('deleteByB on non-existent key is a no-op', () => {
        const bm = new BiMap();
        bm.set(1, 'a');
        bm.deleteByB('zzz');
        assert.equal(bm.size, 1);
        assert.equal(bm.getByA(1), 'a');
    });
});

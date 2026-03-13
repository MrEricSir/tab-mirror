const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isConnectionStale, didWakeFromSleep } = require('../../src/init-helpers.js');

// --- isConnectionStale ---

describe('isConnectionStale', () => {
    test('lastMessageAt is 0 (never received) -> false', () => {
        assert.equal(isConnectionStale(0, 100000, 5000), false);
    });

    test('within timeout -> false', () => {
        assert.equal(isConnectionStale(95000, 100000, 10000), false);
    });

    test('exactly at timeout boundary -> false (not strictly >)', () => {
        assert.equal(isConnectionStale(90000, 100000, 10000), false);
    });

    test('past timeout -> true', () => {
        assert.equal(isConnectionStale(89000, 100000, 10000), true);
    });

    test('negative lastMessageAt -> false', () => {
        assert.equal(isConnectionStale(-1, 100000, 5000), false);
    });
});

// --- didWakeFromSleep ---

describe('didWakeFromSleep', () => {
    test('normal tick (small gap) -> false', () => {
        assert.equal(didWakeFromSleep(101000, 100000, 120000), false);
    });

    test('exactly at threshold -> false (not strictly >)', () => {
        assert.equal(didWakeFromSleep(220000, 100000, 120000), false);
    });

    test('exceeds threshold -> true', () => {
        assert.equal(didWakeFromSleep(220001, 100000, 120000), true);
    });

    test('large gap (long sleep) -> true', () => {
        assert.equal(didWakeFromSleep(1000000, 100000, 120000), true);
    });
});

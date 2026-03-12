const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeRetryBackoff, shouldDialPeer } = require('../../src/transport.js');

// --- computeRetryBackoff ---

describe('computeRetryBackoff', () => {
    test('zero attempts → returns minMs', () => {
        assert.equal(computeRetryBackoff(0, 1000, 60000), 1000);
    });

    test('doubles each attempt', () => {
        assert.equal(computeRetryBackoff(1, 1000, 60000), 2000);
        assert.equal(computeRetryBackoff(2, 1000, 60000), 4000);
        assert.equal(computeRetryBackoff(3, 1000, 60000), 8000);
    });

    test('clamps at maxMs', () => {
        assert.equal(computeRetryBackoff(10, 1000, 60000), 60000);
        assert.equal(computeRetryBackoff(100, 1000, 60000), 60000);
    });

    test('exact boundary: 2^n * min == max', () => {
        // 1000 * 2^6 = 64000 > 60000, so 5 attempts = 32000, 6 = clamped
        assert.equal(computeRetryBackoff(5, 1000, 60000), 32000);
        assert.equal(computeRetryBackoff(6, 1000, 60000), 60000);
    });

    test('large attempt count does not overflow to Infinity', () => {
        const result = computeRetryBackoff(1000, 1000, 60000);
        assert.equal(result, 60000);
    });
});

// --- shouldDialPeer ---

describe('shouldDialPeer', () => {
    const connected = new Set(['peer-c']);
    const pending = new Set(['peer-p']);

    test('returns false for self', () => {
        assert.equal(shouldDialPeer('me', 'me', new Set(), new Set()), false);
    });

    test('returns false if already connected', () => {
        assert.equal(shouldDialPeer('peer-c', 'me', connected, new Set()), false);
    });

    test('returns false if pending', () => {
        assert.equal(shouldDialPeer('peer-p', 'me', new Set(), pending), false);
    });

    test('lower ID dials higher ID → true', () => {
        assert.equal(shouldDialPeer('z-peer', 'a-peer', new Set(), new Set()), true);
    });

    test('higher ID does not dial lower ID → false', () => {
        assert.equal(shouldDialPeer('a-peer', 'z-peer', new Set(), new Set()), false);
    });

    test('equal IDs → false', () => {
        assert.equal(shouldDialPeer('same', 'same', new Set(), new Set()), false);
    });

    test('valid dial: not self, not connected, not pending, lower ID', () => {
        assert.equal(shouldDialPeer('z-peer', 'a-peer', connected, pending), true);
    });
});

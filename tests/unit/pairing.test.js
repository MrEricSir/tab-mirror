const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// pairing.js expects these globals from crypto.js
const { PAIRING_CHARSET, normalizePairingCode } = require('../../src/crypto.js');
globalThis.PAIRING_CHARSET = PAIRING_CHARSET;
globalThis.normalizePairingCode = normalizePairingCode;

const { isValidPairingCode, getSharedKeyForPeer } = require('../../src/pairing.js');

// --- isValidPairingCode ---

describe('isValidPairingCode', () => {
    test('accepts a valid 8-char code', () => {
        assert.equal(isValidPairingCode('ABCD2345'), true);
    });

    test('accepts a formatted code with dash', () => {
        assert.equal(isValidPairingCode('ABCD-2345'), true);
    });

    test('accepts lowercase input (normalizes to uppercase)', () => {
        assert.equal(isValidPairingCode('abcd2345'), true);
    });

    test('rejects a code that is too short', () => {
        assert.equal(isValidPairingCode('ABCD'), false);
    });

    test('rejects a code that is too long', () => {
        assert.equal(isValidPairingCode('ABCD23456'), false);
    });

    test('rejects confusable characters (0, O, 1, I)', () => {
        assert.equal(isValidPairingCode('ABCD0000'), false); // 0 not in charset
        assert.equal(isValidPairingCode('ABCDOOOO'), false); // O not in charset
        assert.equal(isValidPairingCode('ABCD1111'), false); // 1 not in charset
        assert.equal(isValidPairingCode('ABCDIIII'), false); // I not in charset
    });

    test('rejects empty string', () => {
        assert.equal(isValidPairingCode(''), false);
    });

    test('rejects null/undefined', () => {
        assert.equal(isValidPairingCode(null), false);
        assert.equal(isValidPairingCode(undefined), false);
    });
});

// --- getSharedKeyForPeer ---

describe('getSharedKeyForPeer', () => {
    const devices = [
        { peerId: 'device-a', sharedKey: 'keyA', name: 'Device A' },
        { peerId: 'device-b', sharedKey: 'keyB', name: 'Device B' },
    ];

    test('returns the shared key for a known peer', () => {
        assert.equal(getSharedKeyForPeer('device-a', devices), 'keyA');
        assert.equal(getSharedKeyForPeer('device-b', devices), 'keyB');
    });

    test('returns null for an unknown peer', () => {
        assert.equal(getSharedKeyForPeer('device-unknown', devices), null);
    });

    test('returns null for an empty devices array', () => {
        assert.equal(getSharedKeyForPeer('device-a', []), null);
    });

    test('returns the correct key when multiple devices exist', () => {
        const many = [
            { peerId: 'x', sharedKey: 'kx', name: 'X' },
            { peerId: 'y', sharedKey: 'ky', name: 'Y' },
            { peerId: 'z', sharedKey: 'kz', name: 'Z' },
        ];
        assert.equal(getSharedKeyForPeer('y', many), 'ky');
    });
});

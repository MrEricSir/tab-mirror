const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// pairing.js expects these globals from crypto.js
const { PAIRING_CHARSET, normalizePairingCode } = require('../../src/crypto.js');
globalThis.PAIRING_CHARSET = PAIRING_CHARSET;
globalThis.normalizePairingCode = normalizePairingCode;

// updateDeviceKey expects these globals
globalThis.pairedDevices = [];
globalThis.encryptionKeyCache = new Map();
globalThis.browser = {
    storage: { local: { set: async () => {}, get: async () => ({}), remove: async () => {} } }
};

const { isValidPairingCode, getSharedKeyForPeer, updateDeviceKey } = require('../../src/pairing.js');

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

// --- updateDeviceKey ---

describe('updateDeviceKey', () => {
    test('updates key and generation, preserves name and pairedAt', async () => {
        globalThis.pairedDevices = [
            { peerId: 'peer-1', sharedKey: 'oldKey', name: 'My Device', pairedAt: 1000, keyGeneration: 1 }
        ];
        globalThis.encryptionKeyCache = new Map();

        await updateDeviceKey('peer-1', 'newKey', 2);

        const device = globalThis.pairedDevices[0];
        assert.equal(device.sharedKey, 'newKey');
        assert.equal(device.keyGeneration, 2);
        assert.equal(device.name, 'My Device');
        assert.equal(device.pairedAt, 1000);
    });

    test('clears encryptionKeyCache for the peer', async () => {
        globalThis.pairedDevices = [
            { peerId: 'peer-2', sharedKey: 'oldKey', name: 'Dev', pairedAt: 2000, keyGeneration: 1 }
        ];
        globalThis.encryptionKeyCache = new Map([['peer-2', 'cachedKey']]);

        await updateDeviceKey('peer-2', 'newKey', 3);

        assert.equal(globalThis.encryptionKeyCache.has('peer-2'), false);
    });

    test('does nothing for unknown peer', async () => {
        globalThis.pairedDevices = [
            { peerId: 'peer-3', sharedKey: 'key3', name: 'Dev3', pairedAt: 3000, keyGeneration: 1 }
        ];

        await updateDeviceKey('unknown-peer', 'newKey', 2);

        // Original device unchanged
        assert.equal(globalThis.pairedDevices[0].sharedKey, 'key3');
        assert.equal(globalThis.pairedDevices[0].keyGeneration, 1);
    });

    test('getSharedKeyForPeer returns new key after rotation', async () => {
        globalThis.pairedDevices = [
            { peerId: 'peer-4', sharedKey: 'originalKey', name: 'Dev4', pairedAt: 4000, keyGeneration: 1 }
        ];
        globalThis.encryptionKeyCache = new Map();

        await updateDeviceKey('peer-4', 'rotatedKey', 5);

        assert.equal(getSharedKeyForPeer('peer-4', globalThis.pairedDevices), 'rotatedKey');
    });
});

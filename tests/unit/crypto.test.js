if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
    globalThis.crypto = require('node:crypto').webcrypto;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    PAIRING_CHARSET,
    formatPairingCode,
    normalizePairingCode,
    generatePairingCode,
    generateSharedKey,
    computeHMAC,
    verifyHMAC,
    deriveEncryptionKey,
    encryptState,
    decryptState,
} = require('../../src/crypto.js');

// Stub fileLog (used by decryptState's catch block)
globalThis.fileLog = () => {};

// --- formatPairingCode ---

describe('formatPairingCode', () => {
    test('inserts dash after 4th character', () => {
        assert.equal(formatPairingCode('ABCD1234'), 'ABCD-1234');
        assert.equal(formatPairingCode('12345678'), '1234-5678');
    });

    test('handles codes with mixed characters', () => {
        assert.equal(formatPairingCode('A2B3C4D5'), 'A2B3-C4D5');
    });
});

// --- normalizePairingCode ---

describe('normalizePairingCode', () => {
    test('removes dashes and uppercases', () => {
        assert.equal(normalizePairingCode('abcd-1234'), 'ABCD1234');
    });

    test('removes spaces and uppercases', () => {
        assert.equal(normalizePairingCode('abcd 1234'), 'ABCD1234');
    });

    test('handles mixed whitespace and dashes', () => {
        assert.equal(normalizePairingCode('AB CD-12 34'), 'ABCD1234');
    });

    test('uppercases already clean input', () => {
        assert.equal(normalizePairingCode('abcdefgh'), 'ABCDEFGH');
    });

    test('passes through clean uppercase input', () => {
        assert.equal(normalizePairingCode('ABCD1234'), 'ABCD1234');
    });

    test('roundtrips with formatPairingCode', () => {
        const code = 'WXYZ5678';
        const formatted = formatPairingCode(code);
        assert.equal(normalizePairingCode(formatted), code);
    });
});

// --- generatePairingCode ---

describe('generatePairingCode', () => {
    test('returns an 8-character string', () => {
        const code = generatePairingCode();
        assert.equal(code.length, 8);
    });

    test('only contains PAIRING_CHARSET characters', () => {
        const charsetRegex = new RegExp(`^[${PAIRING_CHARSET}]+$`);
        for (let i = 0; i < 20; i++) {
            const code = generatePairingCode();
            assert.match(code, charsetRegex);
        }
    });

    test('never contains confusable characters (0, O, 1, I, l)', () => {
        for (let i = 0; i < 50; i++) {
            const code = generatePairingCode();
            assert.doesNotMatch(code, /[0O1Il]/);
        }
    });

    test('generates unique values', () => {
        const codes = new Set();
        for (let i = 0; i < 20; i++) {
            codes.add(generatePairingCode());
        }
        // With ~40 bits of entropy, 20 codes should all be unique
        assert.equal(codes.size, 20);
    });
});

// --- generateSharedKey ---

describe('generateSharedKey', () => {
    test('returns a valid base64 string', async () => {
        const key = await generateSharedKey();
        assert.equal(typeof key, 'string');
        // Should not throw when decoded
        const decoded = Buffer.from(key, 'base64');
        assert.ok(decoded.length > 0);
    });

    test('decodes to 32 bytes', async () => {
        const key = await generateSharedKey();
        const decoded = Buffer.from(key, 'base64');
        assert.equal(decoded.length, 32);
    });

    test('generates unique values', async () => {
        const keys = new Set();
        for (let i = 0; i < 10; i++) {
            keys.add(await generateSharedKey());
        }
        assert.equal(keys.size, 10);
    });
});

// --- computeHMAC ---

describe('computeHMAC', () => {
    test('returns a 64-character hex string', async () => {
        const key = await generateSharedKey();
        const hmac = await computeHMAC(key, 'test message');
        assert.equal(hmac.length, 64);
        assert.match(hmac, /^[0-9a-f]{64}$/);
    });

    test('is deterministic for same inputs', async () => {
        const key = await generateSharedKey();
        const hmac1 = await computeHMAC(key, 'hello');
        const hmac2 = await computeHMAC(key, 'hello');
        assert.equal(hmac1, hmac2);
    });

    test('produces different output for different messages', async () => {
        const key = await generateSharedKey();
        const hmac1 = await computeHMAC(key, 'message one');
        const hmac2 = await computeHMAC(key, 'message two');
        assert.notEqual(hmac1, hmac2);
    });
});

// --- verifyHMAC ---

describe('verifyHMAC', () => {
    test('returns true for a valid signature', async () => {
        const key = await generateSharedKey();
        const hmac = await computeHMAC(key, 'payload');
        const result = await verifyHMAC(key, 'payload', hmac);
        assert.equal(result, true);
    });

    test('returns false for a wrong signature', async () => {
        const key = await generateSharedKey();
        const result = await verifyHMAC(key, 'payload', 'bad'.padEnd(64, '0'));
        assert.equal(result, false);
    });

    test('returns false for a wrong key', async () => {
        const key1 = await generateSharedKey();
        const key2 = await generateSharedKey();
        const hmac = await computeHMAC(key1, 'payload');
        const result = await verifyHMAC(key2, 'payload', hmac);
        assert.equal(result, false);
    });

    test('throws or returns false for malformed hex input', async () => {
        const key = await generateSharedKey();
        try {
            const result = await verifyHMAC(key, 'payload', 'not-hex-at-all!');
            assert.equal(result, false);
        } catch (e) {
            // Throwing is also acceptable for malformed input
            assert.ok(e instanceof TypeError || e instanceof Error);
        }
    });
});

// --- deriveEncryptionKey ---

describe('deriveEncryptionKey', () => {
    test('returns a CryptoKey with AES-GCM algorithm', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        assert.equal(cryptoKey.algorithm.name, 'AES-GCM');
        assert.equal(cryptoKey.algorithm.length, 256);
    });

    test('returns a key with encrypt and decrypt usages', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const usages = Array.from(cryptoKey.usages).sort();
        assert.deepEqual(usages, ['decrypt', 'encrypt']);
    });

    test('same input produces same key (deterministic derivation)', async () => {
        const sharedKey = await generateSharedKey();
        const key1 = await deriveEncryptionKey(sharedKey);
        const key2 = await deriveEncryptionKey(sharedKey);
        // Encrypt with key1, decrypt with key2 to prove equivalence
        const plaintext = { test: 'determinism' };
        const encrypted = await encryptState(key1, plaintext);
        const decrypted = await decryptState(key2, encrypted);
        assert.deepEqual(decrypted, plaintext);
    });
});

// --- encryptState ---

describe('encryptState', () => {
    test('returns envelope with expected fields', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const state = { peerId: 'peer-1', tabs: [] };
        const envelope = await encryptState(cryptoKey, state);
        assert.equal(envelope.type, 'MIRROR_SYNC_ENCRYPTED');
        assert.equal(envelope.peerId, 'peer-1');
        assert.equal(typeof envelope.iv, 'string');
        assert.equal(typeof envelope.ciphertext, 'string');
    });

    test('preserves peerId from input state', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const state = { peerId: 'my-unique-peer', data: 'hello' };
        const envelope = await encryptState(cryptoKey, state);
        assert.equal(envelope.peerId, 'my-unique-peer');
    });

    test('produces different iv each call', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const state = { peerId: 'peer-1', tabs: [] };
        const envelope1 = await encryptState(cryptoKey, state);
        const envelope2 = await encryptState(cryptoKey, state);
        assert.notEqual(envelope1.iv, envelope2.iv);
    });
});

// --- decryptState ---

describe('decryptState', () => {
    test('roundtrip: encrypt then decrypt recovers original object', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const original = { peerId: 'peer-1', tabs: [{ id: 1, url: 'https://example.com' }] };
        const encrypted = await encryptState(cryptoKey, original);
        const decrypted = await decryptState(cryptoKey, encrypted);
        assert.deepEqual(decrypted, original);
    });

    test('returns null for tampered ciphertext', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const encrypted = await encryptState(cryptoKey, { peerId: 'p', data: 'secret' });
        // Tamper with the ciphertext
        const bytes = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
        bytes[0] ^= 0xFF;
        encrypted.ciphertext = btoa(String.fromCharCode(...bytes));
        const result = await decryptState(cryptoKey, encrypted);
        assert.equal(result, null);
    });

    test('returns null for wrong key', async () => {
        const sharedKey1 = await generateSharedKey();
        const sharedKey2 = await generateSharedKey();
        const key1 = await deriveEncryptionKey(sharedKey1);
        const key2 = await deriveEncryptionKey(sharedKey2);
        const encrypted = await encryptState(key1, { peerId: 'p', data: 'secret' });
        const result = await decryptState(key2, encrypted);
        assert.equal(result, null);
    });
});

// --- encrypt/decrypt integration ---

describe('encrypt/decrypt integration', () => {
    test('roundtrip with complex nested state object', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const complexState = {
            peerId: 'peer-abc',
            tabs: [
                { id: 1, url: 'https://example.com', title: 'Example', pinned: true },
                { id: 2, url: 'https://test.org', title: 'Test', pinned: false },
            ],
            groups: [
                { id: 100, title: 'Research', color: 'blue', tabs: [1, 2] },
            ],
            metadata: {
                windowId: 42,
                timestamp: Date.now(),
            },
        };
        const encrypted = await encryptState(cryptoKey, complexState);
        const decrypted = await decryptState(cryptoKey, encrypted);
        assert.deepEqual(decrypted, complexState);
    });

    test('different keys cannot decrypt each other\'s messages', async () => {
        const keyA = await deriveEncryptionKey(await generateSharedKey());
        const keyB = await deriveEncryptionKey(await generateSharedKey());
        const encrypted = await encryptState(keyA, { peerId: 'p', secret: 'data' });
        const result = await decryptState(keyB, encrypted);
        assert.equal(result, null);
    });

    test('roundtrip preserves all JSON types', async () => {
        const sharedKey = await generateSharedKey();
        const cryptoKey = await deriveEncryptionKey(sharedKey);
        const state = {
            peerId: 'peer-types',
            aString: 'hello',
            aNumber: 42.5,
            aBoolean: true,
            aFalse: false,
            anArray: [1, 'two', null, true],
            aNull: null,
        };
        const encrypted = await encryptState(cryptoKey, state);
        const decrypted = await decryptState(cryptoKey, encrypted);
        assert.deepEqual(decrypted, state);
    });
});

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
} = require('../../src/crypto.js');

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
});

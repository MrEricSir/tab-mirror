const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formatPairingCode, normalizePairingCode } = require('../../src/crypto.js');

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

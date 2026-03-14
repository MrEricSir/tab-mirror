const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Minimal globals needed for background.js to load in Node
if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
    globalThis.crypto = require('node:crypto').webcrypto;
}
globalThis.window = globalThis.window || {};
globalThis.browser = {
    storage: { local: { set: () => Promise.resolve(), remove: () => Promise.resolve() } }
};
// BiMap is loaded as a separate script in the extension; make it available globally for Node
const { BiMap } = require('../../src/bimap.js');
globalThis.BiMap = BiMap;

const {
    isPrivilegedUrl, isSyncableUrl, normalizeUrl,
    isAllowedUrlScheme, generateSyncId, validateTabData, validateRemoteState
} = require('../../src/background.js');

// --- isPrivilegedUrl ---

describe('isPrivilegedUrl', () => {
    test('returns false for null/undefined/empty', () => {
        assert.equal(isPrivilegedUrl(null), false);
        assert.equal(isPrivilegedUrl(undefined), false);
        assert.equal(isPrivilegedUrl(''), false);
    });

    test('returns false for about:blank, about:newtab, about:home', () => {
        assert.equal(isPrivilegedUrl('about:blank'), false);
        assert.equal(isPrivilegedUrl('about:newtab'), false);
        assert.equal(isPrivilegedUrl('about:home'), false);
    });

    test('returns true for other about: pages', () => {
        assert.equal(isPrivilegedUrl('about:config'), true);
        assert.equal(isPrivilegedUrl('about:addons'), true);
        assert.equal(isPrivilegedUrl('about:debugging'), true);
    });

    test('returns true for extension URLs', () => {
        assert.equal(isPrivilegedUrl('moz-extension://abc/page.html'), true);
        assert.equal(isPrivilegedUrl('chrome-extension://abc/page.html'), true);
    });

    test('returns true for testbridge-init URLs', () => {
        assert.equal(isPrivilegedUrl('http://localhost/testbridge-init'), true);
    });

    test('returns false for normal URLs', () => {
        assert.equal(isPrivilegedUrl('http://example.com'), false);
        assert.equal(isPrivilegedUrl('https://example.com'), false);
        assert.equal(isPrivilegedUrl('https://www.google.com'), false);
    });
});

// --- isSyncableUrl ---

describe('isSyncableUrl', () => {
    test('returns false for null/undefined/empty', () => {
        assert.equal(isSyncableUrl(null), false);
        assert.equal(isSyncableUrl(undefined), false);
        assert.equal(isSyncableUrl(''), false);
    });

    test('returns true for about:blank', () => {
        assert.equal(isSyncableUrl('about:blank'), true);
    });

    test('returns false for other about: pages', () => {
        assert.equal(isSyncableUrl('about:config'), false);
        assert.equal(isSyncableUrl('about:newtab'), false);
        assert.equal(isSyncableUrl('about:home'), false);
    });

    test('returns false for extension URLs', () => {
        assert.equal(isSyncableUrl('moz-extension://abc/page.html'), false);
        assert.equal(isSyncableUrl('chrome-extension://abc/page.html'), false);
    });

    test('returns false for testbridge-init URLs', () => {
        assert.equal(isSyncableUrl('http://localhost/testbridge-init'), false);
    });

    test('returns true for normal URLs', () => {
        assert.equal(isSyncableUrl('http://example.com'), true);
        assert.equal(isSyncableUrl('https://example.com'), true);
    });
});

// --- normalizeUrl ---

describe('normalizeUrl', () => {
    test('normalizes about:newtab and about:home to about:blank', () => {
        assert.equal(normalizeUrl('about:newtab'), 'about:blank');
        assert.equal(normalizeUrl('about:home'), 'about:blank');
    });

    test('passes through other URLs unchanged', () => {
        assert.equal(normalizeUrl('about:blank'), 'about:blank');
        assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
        assert.equal(normalizeUrl('http://foo.bar/baz'), 'http://foo.bar/baz');
    });

    test('extracts inner URL from encoded about:reader URL', () => {
        assert.equal(
            normalizeUrl('about:reader?url=https%3A%2F%2Fexample.com%2Farticle'),
            'https://example.com/article'
        );
    });

    test('extracts inner URL from non-encoded about:reader URL', () => {
        assert.equal(
            normalizeUrl('about:reader?url=https://example.com/article'),
            'https://example.com/article'
        );
    });

    test('returns original URL for malformed about:reader encoding', () => {
        assert.equal(
            normalizeUrl('about:reader?url=%ZZ%invalid'),
            'about:reader?url=%ZZ%invalid'
        );
    });
});

// --- isAllowedUrlScheme ---

describe('isAllowedUrlScheme', () => {
    test('returns false for null/undefined/empty', () => {
        assert.equal(isAllowedUrlScheme(null), false);
        assert.equal(isAllowedUrlScheme(undefined), false);
        assert.equal(isAllowedUrlScheme(''), false);
    });

    test('returns true for http and https', () => {
        assert.equal(isAllowedUrlScheme('http://example.com'), true);
        assert.equal(isAllowedUrlScheme('https://example.com'), true);
    });

    test('returns true for allowed about: pages', () => {
        assert.equal(isAllowedUrlScheme('about:blank'), true);
        assert.equal(isAllowedUrlScheme('about:newtab'), true);
        assert.equal(isAllowedUrlScheme('about:home'), true);
    });

    test('returns false for disallowed schemes', () => {
        assert.equal(isAllowedUrlScheme('about:config'), false);
        assert.equal(isAllowedUrlScheme('ftp://example.com'), false);
        assert.equal(isAllowedUrlScheme('javascript:alert(1)'), false);
        assert.equal(isAllowedUrlScheme('data:text/html,<h1>hi</h1>'), false);
        assert.equal(isAllowedUrlScheme('moz-extension://abc'), false);
    });
});

// --- generateSyncId ---

describe('generateSyncId', () => {
    test('returns string starting with given prefix', () => {
        const id = generateSyncId('sid_');
        assert.ok(id.startsWith('sid_'));

        const gid = generateSyncId('gsid_');
        assert.ok(gid.startsWith('gsid_'));
    });

    test('returns prefix + 16 hex characters', () => {
        const id = generateSyncId('sid_');
        const hex = id.slice(4);
        assert.equal(hex.length, 16);
        assert.match(hex, /^[0-9a-f]{16}$/);
    });

    test('generates unique values', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(generateSyncId('sid_'));
        }
        assert.equal(ids.size, 100);
    });
});

// --- validateTabData ---

describe('validateTabData', () => {
    test('rejects null/undefined/no sId', () => {
        assert.equal(validateTabData(null), false);
        assert.equal(validateTabData(undefined), false);
        assert.equal(validateTabData({}), false);
        assert.equal(validateTabData({ url: 'https://example.com' }), false);
    });

    test('accepts valid tab data', () => {
        assert.equal(validateTabData({ sId: 'sid_1', url: 'https://example.com' }), true);
        assert.equal(validateTabData({ sId: 'sid_2', url: 'about:blank' }), true);
        assert.equal(validateTabData({ sId: 'sid_3', url: 'http://foo.com', index: 5 }), true);
    });

    test('rejects disallowed URL schemes', () => {
        assert.equal(validateTabData({ sId: 'x', url: 'javascript:alert(1)' }), false);
        assert.equal(validateTabData({ sId: 'x', url: 'ftp://example.com' }), false);
        assert.equal(validateTabData({ sId: 'x', url: 'data:text/html,hi' }), false);
    });

    test('rejects URLs exceeding max length', () => {
        assert.equal(validateTabData({ sId: 'x', url: 'https://' + 'a'.repeat(8200) }), false);
    });

    test('rejects invalid tab index', () => {
        assert.equal(validateTabData({ sId: 'x', url: 'https://a.com', index: -1 }), false);
        assert.equal(validateTabData({ sId: 'x', url: 'https://a.com', index: 10001 }), false);
    });

    test('accepts valid tab index', () => {
        assert.equal(validateTabData({ sId: 'x', url: 'https://a.com', index: 0 }), true);
        assert.equal(validateTabData({ sId: 'x', url: 'https://a.com', index: 100 }), true);
    });
});

// --- validateRemoteState ---

describe('validateRemoteState', () => {
    test('rejects non-string peerId', () => {
        assert.equal(validateRemoteState({ peerId: 123, tabs: [] }), null);
        assert.equal(validateRemoteState({ peerId: null, tabs: [] }), null);
    });

    test('rejects peerId exceeding max length', () => {
        assert.equal(validateRemoteState({ peerId: 'x'.repeat(200), tabs: [] }), null);
    });

    test('rejects non-array tabs', () => {
        assert.equal(validateRemoteState({ peerId: 'peer1', tabs: 'not-array' }), null);
        assert.equal(validateRemoteState({ peerId: 'peer1', tabs: {} }), null);
    });

    test('accepts valid state and passes through', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [{ sId: 'sid_1', url: 'https://example.com' }],
            groups: {}
        });
        assert.notEqual(result, null);
        assert.equal(result.tabs.length, 1);
        assert.equal(result.tabs[0].sId, 'sid_1');
    });

    test('filters invalid tabs', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [
                { sId: 'sid_1', url: 'https://example.com' },
                { sId: 'sid_2', url: 'javascript:alert(1)' },
                { url: 'https://no-sid.com' }
            ],
            groups: {}
        });
        assert.notEqual(result, null);
        assert.equal(result.tabs.length, 1);
        assert.equal(result.tabs[0].sId, 'sid_1');
    });

    test('deduplicates tabs by sId', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [
                { sId: 'sid_1', url: 'https://first.com' },
                { sId: 'sid_1', url: 'https://duplicate.com' }
            ],
            groups: {}
        });
        assert.notEqual(result, null);
        assert.equal(result.tabs.length, 1);
        assert.equal(result.tabs[0].url, 'https://first.com');
    });

    test('truncates tabs exceeding max count', () => {
        const tabs = [];
        for (let i = 0; i < 600; i++) {
            tabs.push({ sId: `sid_${i}`, url: 'https://example.com' });
        }
        const result = validateRemoteState({ peerId: 'peer1', tabs, groups: {} });
        assert.notEqual(result, null);
        assert.equal(result.tabs.length, 500);
    });

    test('normalizes invalid group colors to grey', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [],
            groups: { g1: { title: 'Test', color: 'invalid-color' } }
        });
        assert.notEqual(result, null);
        assert.equal(result.groups.g1.color, 'grey');
    });

    test('accepts valid group colors', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [],
            groups: { g1: { title: 'Test', color: 'blue' } }
        });
        assert.notEqual(result, null);
        assert.equal(result.groups.g1.color, 'blue');
    });

    test('truncates long group titles', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [],
            groups: { g1: { title: 'x'.repeat(300), color: 'blue' } }
        });
        assert.notEqual(result, null);
        assert.equal(result.groups.g1.title.length, 256);
    });

    test('handles missing groups gracefully', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [{ sId: 'sid_1', url: 'https://example.com' }]
        });
        assert.notEqual(result, null);
        assert.deepEqual(result.groups, {});
    });

    test('removes invalid group entries', () => {
        const result = validateRemoteState({
            peerId: 'peer1',
            tabs: [],
            groups: { g1: null, g2: 'not-object', g3: { title: 'Valid', color: 'red' } }
        });
        assert.notEqual(result, null);
        assert.equal(result.groups.g1, undefined);
        assert.equal(result.groups.g2, undefined);
        assert.equal(result.groups.g3.title, 'Valid');
    });
});

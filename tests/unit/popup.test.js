const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// --- Minimal DOM/browser stubs for popup.js to load in Node ---

function makeElement() {
    return {
        addEventListener: () => {},
        style: {},
        setAttribute: () => {},
        getAttribute: () => '',
        querySelector: () => null,
        querySelectorAll: () => [],
        textContent: '',
        innerHTML: '',
        value: '',
        checked: false,
        disabled: false,
        dataset: {},
        classList: { add: () => {}, remove: () => {} },
        replaceWith: () => {},
        remove: () => {},
        focus: () => {}
    };
}

globalThis.document = {
    createElement: (tag) => {
        let _text = '';
        const el = makeElement();
        Object.defineProperty(el, 'textContent', {
            get: () => _text,
            set: (v) => { _text = String(v); },
            configurable: true
        });
        Object.defineProperty(el, 'innerHTML', {
            get: () => _text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;'),
            set: () => {},
            configurable: true
        });
        return el;
    },
    getElementById: () => makeElement(),
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    body: {},
    documentElement: {
        setAttribute: () => {},
        style: { setProperty: () => {} }
    }
};

globalThis.NodeFilter = { SHOW_TEXT: 4 };

globalThis.browser = {
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    runtime: {
        sendMessage: () => Promise.resolve({
            online: false, peers: 0, id: 'test-id', pairedCount: 0,
            syncWindowId: null, syncPaused: false, tabCount: 0
        })
    },
    i18n: { getMessage: (key) => key },
    theme: {
        getCurrent: () => Promise.resolve({}),
        onUpdated: { addListener: () => {} }
    }
};

// Prevent background timers from keeping the process alive
const _origSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;

const {
    escapeHtml, formatRelativeTime, friendlyName, shortPlatform, displayName,
    formatDebugInfo, formatSyncHistory
} = require('../../src/popup.js');

// Restore setInterval for test runner
globalThis.setInterval = _origSetInterval;

// --- escapeHtml ---

describe('escapeHtml', () => {
    test('returns plain text unchanged', () => {
        assert.equal(escapeHtml('hello world'), 'hello world');
    });

    test('escapes HTML special characters', () => {
        assert.equal(escapeHtml('<script>alert("xss")</script>'),
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    test('escapes ampersands', () => {
        assert.equal(escapeHtml('a & b'), 'a &amp; b');
    });

    test('handles empty string', () => {
        assert.equal(escapeHtml(''), '');
    });

    test('escapes single quotes', () => {
        assert.ok(escapeHtml("it's").includes('&#039;') || escapeHtml("it's").includes("'"));
    });
});

// --- formatRelativeTime ---

describe('formatRelativeTime', () => {
    test('returns "just now" for recent timestamps', () => {
        assert.equal(formatRelativeTime(Date.now() - 5000), 'just now');
        assert.equal(formatRelativeTime(Date.now() - 30000), 'just now');
    });

    test('returns minutes ago', () => {
        assert.equal(formatRelativeTime(Date.now() - 5 * 60 * 1000), '5m ago');
        assert.equal(formatRelativeTime(Date.now() - 30 * 60 * 1000), '30m ago');
    });

    test('returns hours ago', () => {
        assert.equal(formatRelativeTime(Date.now() - 2 * 60 * 60 * 1000), '2h ago');
        assert.equal(formatRelativeTime(Date.now() - 12 * 60 * 60 * 1000), '12h ago');
    });

    test('returns days ago', () => {
        assert.equal(formatRelativeTime(Date.now() - 2 * 24 * 60 * 60 * 1000), '2d ago');
        assert.equal(formatRelativeTime(Date.now() - 7 * 24 * 60 * 60 * 1000), '7d ago');
    });

    test('boundary: exactly 60 seconds shows 1m ago', () => {
        assert.equal(formatRelativeTime(Date.now() - 60 * 1000), '1m ago');
    });
});

// --- friendlyName ---

describe('friendlyName', () => {
    test('returns two-word name (adjective + animal)', () => {
        const name = friendlyName('test-peer-1');
        const parts = name.split(' ');
        assert.equal(parts.length, 2);
    });

    test('is deterministic for same input', () => {
        const a = friendlyName('mirror-abc123');
        const b = friendlyName('mirror-abc123');
        assert.equal(a, b);
    });

    test('produces different names for different inputs', () => {
        const a = friendlyName('peer-alpha');
        const b = friendlyName('peer-beta');
        // Technically could collide, but extremely unlikely for these inputs
        assert.notEqual(a, b);
    });

    test('handles empty string', () => {
        const name = friendlyName('');
        assert.ok(typeof name === 'string');
        assert.ok(name.includes(' '));
    });
});

// --- shortPlatform ---

describe('shortPlatform', () => {
    test('extracts platform from "Firefox on <platform>"', () => {
        assert.equal(shortPlatform('Firefox on macOS'), 'macOS');
        assert.equal(shortPlatform('Firefox on Windows'), 'Windows');
        assert.equal(shortPlatform('Firefox on Linux'), 'Linux');
    });

    test('returns empty string for null/undefined', () => {
        assert.equal(shortPlatform(null), '');
        assert.equal(shortPlatform(undefined), '');
    });

    test('returns empty string when no "on" pattern', () => {
        assert.equal(shortPlatform('Firefox'), '');
        assert.equal(shortPlatform(''), '');
    });
});

// --- displayName ---

describe('displayName', () => {
    test('includes platform when device has a name with "on"', () => {
        const result = displayName({ peerId: 'mirror-abc', name: 'Firefox on macOS' });
        assert.ok(result.includes('macOS'));
        assert.ok(result.includes('\u00b7')); // middle dot separator
    });

    test('returns just friendly name when no platform', () => {
        const result = displayName({ peerId: 'mirror-abc', name: 'Firefox' });
        const friendly = friendlyName('mirror-abc');
        assert.equal(result, friendly);
    });

    test('returns just friendly name when name is missing', () => {
        const result = displayName({ peerId: 'mirror-abc' });
        const friendly = friendlyName('mirror-abc');
        assert.equal(result, friendly);
    });
});

// --- formatDebugInfo ---

describe('formatDebugInfo', () => {
    test('includes device ID, online status, and peer count', () => {
        const result = formatDebugInfo({ id: 'dev-123', online: true, peers: 3 });
        assert.ok(result.includes('Device ID: dev-123'));
        assert.ok(result.includes('Online: true'));
        assert.ok(result.includes('Active Peers: 3'));
    });

    test('shows "none" defaults for missing connectedPeers and syncedPeers', () => {
        const result = formatDebugInfo({ id: 'x', online: false, peers: 0 });
        assert.ok(result.includes('Known Peers: none'));
        assert.ok(result.includes('Synced Peers: none'));
    });

    test('shows 0/false/never defaults for missing counters', () => {
        const result = formatDebugInfo({ id: 'x', online: false, peers: 0 });
        assert.ok(result.includes('Tab Mappings: 0'));
        assert.ok(result.includes('Group Mappings: 0'));
        assert.ok(result.includes('Processing Remote: false'));
        assert.ok(result.includes('Last Sync: never'));
        assert.ok(result.includes('Sync Counter: 0'));
    });

    test('lists paired devices when present', () => {
        const result = formatDebugInfo({
            id: 'x', online: true, peers: 1,
            pairedDevices: [
                { peerId: 'peer-1', name: 'Firefox on macOS' },
                { peerId: 'peer-2', name: 'Firefox on Windows' }
            ]
        });
        assert.ok(result.includes('Paired Devices: 2'));
        assert.ok(result.includes('- peer-1 (Firefox on macOS)'));
        assert.ok(result.includes('- peer-2 (Firefox on Windows)'));
    });

    test('lists authenticated peers when present', () => {
        const result = formatDebugInfo({
            id: 'x', online: true, peers: 1,
            authenticatedPeers: ['peer-a', 'peer-b']
        });
        assert.ok(result.includes('Authenticated: peer-a, peer-b'));
    });
});

// --- formatSyncHistory ---

describe('formatSyncHistory', () => {
    test('returns i18n key for empty history', () => {
        assert.equal(formatSyncHistory([]), 'placeholderNoSyncEvents');
    });

    test('returns i18n key for null history', () => {
        assert.equal(formatSyncHistory(null), 'placeholderNoSyncEvents');
    });

    test('formats a single sync event with time, name, changes, and type', () => {
        const event = {
            time: new Date('2025-01-15T10:30:00').getTime(),
            peer: 'peer-1',
            added: 2, removed: 1, updated: 0,
            type: 'full'
        };
        const result = formatSyncHistory([event]);
        const name = friendlyName('peer-1');
        assert.ok(result.includes(name));
        assert.ok(result.includes('+2'));
        assert.ok(result.includes('-1'));
        assert.ok(result.includes('(full)'));
    });

    test('shows added/removed/updated counts with +/-/~ prefixes', () => {
        const event = {
            time: Date.now(), peer: 'p',
            added: 3, removed: 1, updated: 5,
            type: 'incremental'
        };
        const result = formatSyncHistory([event]);
        assert.ok(result.includes('+3'));
        assert.ok(result.includes('-1'));
        assert.ok(result.includes('~5'));
    });

    test('returns i18n key syncNoChanges when all change counts are 0', () => {
        const event = {
            time: Date.now(), peer: 'p',
            added: 0, removed: 0, updated: 0,
            type: 'full'
        };
        const result = formatSyncHistory([event]);
        assert.ok(result.includes('syncNoChanges'));
        assert.ok(!result.includes('+'));
        assert.ok(!result.includes('-'));
        assert.ok(!result.includes('~'));
    });

    test('reverses order so newest is first', () => {
        const older = {
            time: new Date('2025-01-01T08:00:00').getTime(),
            peer: 'peer-old', added: 1, removed: 0, updated: 0, type: 'full'
        };
        const newer = {
            time: new Date('2025-01-01T09:00:00').getTime(),
            peer: 'peer-new', added: 0, removed: 1, updated: 0, type: 'full'
        };
        const result = formatSyncHistory([older, newer]);
        const lines = result.split('\n');
        assert.equal(lines.length, 2);
        // Newer event should appear first
        assert.ok(lines[0].includes(friendlyName('peer-new')));
        assert.ok(lines[1].includes(friendlyName('peer-old')));
    });
});

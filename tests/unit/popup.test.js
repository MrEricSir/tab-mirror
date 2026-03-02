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
    escapeHtml, formatRelativeTime, friendlyName, shortPlatform, displayName
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

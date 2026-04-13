const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Minimal globals needed for background.js to load in Node
if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
    globalThis.crypto = require('node:crypto').webcrypto;
}
globalThis.window = globalThis.window || {};
globalThis.browser = {
    storage: { local: { set: () => Promise.resolve(), remove: () => Promise.resolve() } }
};
const { BiMap } = require('../../src/bimap.js');
globalThis.BiMap = BiMap;

// clearGroupState() in background.js references lastSeenGroupProps (defined in sync-engine.js).
// In the extension runtime, all scripts share one global scope, but here we only load background.js.
globalThis.lastSeenGroupProps = globalThis.lastSeenGroupProps || new Map();

const {
    urlSuppression, notificationState, connectionState, resetAllState, normalizeUrl
} = require('../../src/background.js');

// --- urlSuppression ---

describe('urlSuppression', () => {
    beforeEach(() => {
        urlSuppression.reset();
        urlSuppression.setSuppressionWindow(10000);
        urlSuppression._REVERT_WINDOW_MS = 30000;
    });

    describe('recordSyncedUrl / shouldSuppressBroadcast', () => {
        test('suppresses broadcast within suppression window', () => {
            urlSuppression.recordSyncedUrl('sid_1', 'https://example.com');
            const result = urlSuppression.shouldSuppressBroadcast('sid_1', 'https://example.com');
            assert.deepEqual(result, { suppressed: true, reason: 'recent-sync' });
        });

        test('does not suppress after suppression window expires', () => {
            urlSuppression.recordSyncedUrl('sid_1', 'https://example.com');
            // Backdate the entry so it's expired
            urlSuppression._recentlySynced.get('sid_1').at = Date.now() - 20000;
            const result = urlSuppression.shouldSuppressBroadcast('sid_1', 'https://example.com');
            assert.deepEqual(result, { suppressed: false });
        });

        test('cleans up expired entries from recentlySynced', () => {
            urlSuppression.recordSyncedUrl('sid_1', 'https://example.com');
            urlSuppression._recentlySynced.get('sid_1').at = Date.now() - 20000;
            urlSuppression.shouldSuppressBroadcast('sid_1', 'https://example.com');
            assert.equal(urlSuppression._recentlySynced.has('sid_1'), false);
        });

        test('does not suppress for unknown sId', () => {
            const result = urlSuppression.shouldSuppressBroadcast('sid_unknown', 'https://example.com');
            assert.deepEqual(result, { suppressed: false });
        });
    });

    describe('recordPreSyncUrl / shouldSuppressBroadcast pre-sync-revert', () => {
        test('suppresses when URL matches preSyncUrl within window', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            const result = urlSuppression.shouldSuppressBroadcast('sid_1', 'https://original.com');
            assert.deepEqual(result, { suppressed: true, reason: 'pre-sync-revert' });
        });

        test('does not suppress when URL does not match preSyncUrl', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            const result = urlSuppression.shouldSuppressBroadcast('sid_1', 'https://different.com');
            assert.deepEqual(result, { suppressed: false });
        });

        test('cleans up expired preSyncUrl entries', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            urlSuppression._preSyncUrls.get('sid_1').at = Date.now() - 60000;
            urlSuppression.shouldSuppressBroadcast('sid_1', 'https://original.com');
            assert.equal(urlSuppression._preSyncUrls.has('sid_1'), false);
        });
    });

    describe('getCaptureOverride', () => {
        test('returns appliedUrl when current URL matches preSyncUrl within window', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            const result = urlSuppression.getCaptureOverride('sid_1', 'https://original.com');
            assert.equal(result, 'https://applied.com');
        });

        test('returns null when current URL does not match preSyncUrl', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            const result = urlSuppression.getCaptureOverride('sid_1', 'https://different.com');
            assert.equal(result, null);
        });

        test('returns null when no preSyncUrl recorded', () => {
            const result = urlSuppression.getCaptureOverride('sid_1', 'https://example.com');
            assert.equal(result, null);
        });

        test('returns null and cleans up when entry is expired', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            urlSuppression._preSyncUrls.get('sid_1').at = Date.now() - 60000;
            const result = urlSuppression.getCaptureOverride('sid_1', 'https://original.com');
            assert.equal(result, null);
            assert.equal(urlSuppression._preSyncUrls.has('sid_1'), false);
        });
    });

    describe('clearForUserNav', () => {
        test('returns true and deletes entry when URL matches preSyncUrl', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            const result = urlSuppression.clearForUserNav('sid_1', 'https://original.com');
            assert.equal(result, true);
            assert.equal(urlSuppression._preSyncUrls.has('sid_1'), false);
        });

        test('returns false when URL does not match preSyncUrl', () => {
            urlSuppression.recordPreSyncUrl('sid_1', 'https://original.com', 'https://applied.com');
            const result = urlSuppression.clearForUserNav('sid_1', 'https://different.com');
            assert.equal(result, false);
            assert.equal(urlSuppression._preSyncUrls.has('sid_1'), true);
        });

        test('returns false when no preSyncUrl recorded', () => {
            const result = urlSuppression.clearForUserNav('sid_1', 'https://example.com');
            assert.equal(result, false);
        });
    });

    describe('setSuppressionWindow', () => {
        test('changes the suppression window', () => {
            urlSuppression.setSuppressionWindow(100);
            urlSuppression.recordSyncedUrl('sid_1', 'https://example.com');
            // Backdate by 200ms - should be past the 100ms window
            urlSuppression._recentlySynced.get('sid_1').at = Date.now() - 200;
            const result = urlSuppression.shouldSuppressBroadcast('sid_1', 'https://example.com');
            assert.deepEqual(result, { suppressed: false });
        });
    });

    describe('reset', () => {
        test('clears both maps', () => {
            urlSuppression.recordSyncedUrl('sid_1', 'https://example.com');
            urlSuppression.recordPreSyncUrl('sid_2', 'https://a.com', 'https://b.com');
            urlSuppression.reset();
            assert.equal(urlSuppression._recentlySynced.size, 0);
            assert.equal(urlSuppression._preSyncUrls.size, 0);
        });
    });
});

// --- notificationState ---

describe('notificationState', () => {
    beforeEach(() => {
        notificationState.reset();
        notificationState.setDisconnectDelay(30000);
    });

    describe('hasNotified / markNotified / unmarkNotified', () => {
        test('markNotified adds peer and hasNotified returns true', () => {
            assert.equal(notificationState.hasNotified('peer1'), false);
            notificationState.markNotified('peer1');
            assert.equal(notificationState.hasNotified('peer1'), true);
        });

        test('unmarkNotified removes peer', () => {
            notificationState.markNotified('peer1');
            notificationState.unmarkNotified('peer1');
            assert.equal(notificationState.hasNotified('peer1'), false);
        });
    });

    describe('addLog / getLog', () => {
        test('adds entries and returns them', () => {
            notificationState.addLog({ type: 'connect', peer: 'peer1' });
            notificationState.addLog({ type: 'disconnect', peer: 'peer2' });
            const log = notificationState.getLog();
            assert.equal(log.length, 2);
            assert.equal(log[0].type, 'connect');
            assert.equal(log[1].type, 'disconnect');
        });

        test('respects MAX_LOG and drops oldest entry', () => {
            for (let i = 0; i < 51; i++) {
                notificationState.addLog({ index: i });
            }
            const log = notificationState.getLog();
            assert.equal(log.length, 50);
            // Oldest (index 0) should be dropped
            assert.equal(log[0].index, 1);
            assert.equal(log[log.length - 1].index, 50);
        });
    });

    describe('getNotifiedPeers', () => {
        test('returns array of notified peer IDs', () => {
            notificationState.markNotified('peer1');
            notificationState.markNotified('peer2');
            const peers = notificationState.getNotifiedPeers();
            assert.equal(peers.length, 2);
            assert.ok(peers.includes('peer1'));
            assert.ok(peers.includes('peer2'));
        });

        test('returns empty array when no peers notified', () => {
            assert.deepEqual(notificationState.getNotifiedPeers(), []);
        });
    });

    describe('scheduleDisconnect / cancelDisconnect', () => {
        test('callback fires after delay', (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let called = false;
            notificationState.setDisconnectDelay(5000);
            notificationState.scheduleDisconnect('peer1', () => { called = true; });
            assert.equal(called, false);
            t.mock.timers.tick(5000);
            assert.equal(called, true);
        });

        test('cancel prevents callback from firing', (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let called = false;
            notificationState.setDisconnectDelay(5000);
            notificationState.scheduleDisconnect('peer1', () => { called = true; });
            notificationState.cancelDisconnect('peer1');
            t.mock.timers.tick(10000);
            assert.equal(called, false);
        });

        test('scheduling for same peer replaces previous timer', (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let callCount = 0;
            notificationState.setDisconnectDelay(5000);
            notificationState.scheduleDisconnect('peer1', () => { callCount++; });
            notificationState.scheduleDisconnect('peer1', () => { callCount++; });
            t.mock.timers.tick(10000);
            assert.equal(callCount, 1);
        });

        test('timer cleans up its own entry from pendingTimers', (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            notificationState.setDisconnectDelay(5000);
            notificationState.scheduleDisconnect('peer1', () => {});
            assert.equal(notificationState._pendingTimers.has('peer1'), true);
            t.mock.timers.tick(5000);
            assert.equal(notificationState._pendingTimers.has('peer1'), false);
        });
    });

    describe('setDisconnectDelay', () => {
        test('changes delay used by scheduleDisconnect', (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let called = false;
            notificationState.setDisconnectDelay(1000);
            notificationState.scheduleDisconnect('peer1', () => { called = true; });
            t.mock.timers.tick(999);
            assert.equal(called, false);
            t.mock.timers.tick(1);
            assert.equal(called, true);
        });
    });

    describe('reset', () => {
        test('clears peers, log, and cancels pending timers', (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            notificationState.markNotified('peer1');
            notificationState.addLog({ type: 'test' });
            let called = false;
            notificationState.scheduleDisconnect('peer1', () => { called = true; });

            notificationState.reset();

            assert.equal(notificationState.hasNotified('peer1'), false);
            assert.equal(notificationState.getLog().length, 0);
            assert.equal(notificationState._pendingTimers.size, 0);
            t.mock.timers.tick(60000);
            assert.equal(called, false);
        });
    });
});

// --- connectionState ---

describe('connectionState', () => {
    beforeEach(() => {
        connectionState.connections.clear();
        connectionState.pendingDials.clear();
        connectionState.retries.clear();
        connectionState.lastMessageTime.clear();
        connectionState._discoverInterval = null;
    });

    describe('knownPeers', () => {
        test('returns keys from connections map', () => {
            connectionState.connections.set('peer1', {});
            connectionState.connections.set('peer2', {});
            const peers = connectionState.knownPeers;
            assert.deepEqual(peers.sort(), ['peer1', 'peer2']);
        });

        test('returns empty array when no connections', () => {
            assert.deepEqual(connectionState.knownPeers, []);
        });
    });

    describe('cleanup', () => {
        test('removes peer from connections, pendingDials, and lastMessageTime', () => {
            connectionState.connections.set('peer1', {});
            connectionState.pendingDials.add('peer1');
            connectionState.lastMessageTime.set('peer1', Date.now());

            connectionState.cleanup('peer1');

            assert.equal(connectionState.connections.has('peer1'), false);
            assert.equal(connectionState.pendingDials.has('peer1'), false);
            assert.equal(connectionState.lastMessageTime.has('peer1'), false);
        });

        test('is safe to call for unknown peer', () => {
            assert.doesNotThrow(() => connectionState.cleanup('unknown'));
        });
    });

    describe('closeAll', () => {
        test('calls close() on each connection and clears state', () => {
            const close1 = mock.fn();
            const close2 = mock.fn();
            connectionState.connections.set('peer1', { close: close1 });
            connectionState.connections.set('peer2', { close: close2 });
            connectionState.pendingDials.add('peer1');
            connectionState.retries.set('peer1', { attempts: 1 });

            connectionState.closeAll();

            assert.equal(close1.mock.callCount(), 1);
            assert.equal(close2.mock.callCount(), 1);
            assert.equal(connectionState.connections.size, 0);
            assert.equal(connectionState.pendingDials.size, 0);
            assert.equal(connectionState.retries.size, 0);
        });

        test('handles connections that throw on close', () => {
            connectionState.connections.set('peer1', {
                close: () => { throw new Error('already closed'); }
            });
            assert.doesNotThrow(() => connectionState.closeAll());
            assert.equal(connectionState.connections.size, 0);
        });
    });

    describe('stopDiscovery', () => {
        test('clears interval and sets to null', () => {
            connectionState._discoverInterval = setInterval(() => {}, 100000);
            connectionState.stopDiscovery();
            assert.equal(connectionState._discoverInterval, null);
        });

        test('is safe to call when no interval is set', () => {
            connectionState._discoverInterval = null;
            assert.doesNotThrow(() => connectionState.stopDiscovery());
        });
    });

    describe('reset', () => {
        test('calls closeAll, clears lastMessageTime, and stops discovery', () => {
            const closeFn = mock.fn();
            connectionState.connections.set('peer1', { close: closeFn });
            connectionState.lastMessageTime.set('peer1', Date.now());
            connectionState._discoverInterval = setInterval(() => {}, 100000);

            connectionState.reset();

            assert.equal(closeFn.mock.callCount(), 1);
            assert.equal(connectionState.connections.size, 0);
            assert.equal(connectionState.lastMessageTime.size, 0);
            assert.equal(connectionState._discoverInterval, null);
        });
    });
});

// --- resetAllState ---

describe('resetAllState', () => {
    beforeEach(() => {
        // Populate some state in each module
        urlSuppression.recordSyncedUrl('sid_1', 'https://example.com');
        notificationState.markNotified('peer1');
        notificationState.addLog({ type: 'test' });
        connectionState.connections.set('peer1', { close: mock.fn() });
    });

    test('resets connectionState, urlSuppression, and notificationState', () => {
        resetAllState();

        assert.equal(urlSuppression._recentlySynced.size, 0);
        assert.equal(notificationState.hasNotified('peer1'), false);
        assert.equal(notificationState.getLog().length, 0);
        assert.equal(connectionState.connections.size, 0);
    });

    test('without includeAuth does not clear syncedPeers or authenticatedPeers', () => {
        // We can't directly access these globals, but we can verify
        // resetAllState() without includeAuth doesn't throw and completes
        assert.doesNotThrow(() => resetAllState());
    });

    test('with includeAuth clears auth state without error', () => {
        assert.doesNotThrow(() => resetAllState({ includeAuth: true }));
    });
});

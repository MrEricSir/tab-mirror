const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Minimal globals needed for background.js to load in Node
if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
    globalThis.crypto = require('node:crypto').webcrypto;
}
globalThis.window = globalThis.window || {};
globalThis.browser = globalThis.browser || {
    storage: { local: { set: () => Promise.resolve(), remove: () => Promise.resolve() } }
};
// BiMap is loaded as a separate script in the extension; make it available globally for Node
const { BiMap } = require('../../src/bimap.js');
globalThis.BiMap = BiMap;

// Stubs needed by findMatchingLocalTab (uses isPrivilegedUrl / normalizeUrl globals)
const bg = require('../../src/background.js');
globalThis.isPrivilegedUrl = bg.isPrivilegedUrl;
globalThis.normalizeUrl = bg.normalizeUrl;

const { computeAtomicMerge, computeRemoteDiff, findMatchingLocalTab, buildTabGroupingMap, matchTabsToMappings } = require('../../src/sync-engine.js');

// --- computeAtomicMerge ---

describe('computeAtomicMerge', () => {
    const tab = (sId, url, opts = {}) => ({ sId, url, pinned: false, muted: false, ...opts });

    test('both peers empty → empty result', () => {
        const local = { tabs: [], groups: {}, peerId: 'A' };
        const remote = { tabs: [], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.deepEqual(result, { tabs: [], groups: {} });
    });

    test('one peer empty, other has tabs → returns those tabs', () => {
        const t1 = tab('s1', 'https://a.com');
        const local = { tabs: [t1], groups: {}, peerId: 'A' };
        const remote = { tabs: [], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs.length, 1);
        assert.equal(result.tabs[0].sId, 's1');
    });

    test('no overlap → all tabs from both peers', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s2', 'https://b.com');
        const local = { tabs: [t1], groups: {}, peerId: 'A' };
        const remote = { tabs: [t2], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs.length, 2);
    });

    test('duplicate syncIds → deduplicated (first state wins)', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s1', 'https://b.com');
        // 'B' > 'A', so remote (B) is firstState
        const local = { tabs: [t1], groups: {}, peerId: 'A' };
        const remote = { tabs: [t2], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs.length, 1);
        assert.equal(result.tabs[0].url, 'https://b.com'); // first state (B) wins
    });

    test('duplicate URL+pinned → deduplicated', () => {
        const t1 = tab('s1', 'https://same.com');
        const t2 = tab('s2', 'https://same.com');
        // 'B' > 'A', so remote (B) is firstState, local (A) is secondState
        const local = { tabs: [t1], groups: {}, peerId: 'A' };
        const remote = { tabs: [t2], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs.length, 1);
        assert.equal(result.tabs[0].sId, 's2'); // first state tab kept
    });

    test('duplicate URL with different pinned → both kept', () => {
        const t1 = tab('s1', 'https://same.com', { pinned: true });
        const t2 = tab('s2', 'https://same.com', { pinned: false });
        const local = { tabs: [t1], groups: {}, peerId: 'A' };
        const remote = { tabs: [t2], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs.length, 2);
    });

    test('groups unioned from both states', () => {
        const local = { tabs: [], groups: { g1: { title: 'Work', color: 'blue' } }, peerId: 'A' };
        const remote = { tabs: [], groups: { g2: { title: 'Play', color: 'red' } }, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.deepEqual(result.groups, {
            g1: { title: 'Work', color: 'blue' },
            g2: { title: 'Play', color: 'red' }
        });
    });

    test('order stability: higher peerId tabs come first', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s2', 'https://b.com');
        // myDeviceId='A', remote peerId='B'. B > A, so remote tabs first.
        const local = { tabs: [t1], groups: {}, peerId: 'A' };
        const remote = { tabs: [t2], groups: {}, peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs[0].sId, 's2'); // B's tab first
        assert.equal(result.tabs[1].sId, 's1'); // A's tab second
    });

    test('order stability: when I am higher, my tabs come first', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s2', 'https://b.com');
        // myDeviceId='Z', remote peerId='A'. Z > A, so local tabs first.
        const local = { tabs: [t1], groups: {}, peerId: 'Z' };
        const remote = { tabs: [t2], groups: {}, peerId: 'A' };
        const result = computeAtomicMerge(local, remote, 'Z');
        assert.equal(result.tabs[0].sId, 's1'); // Z's tab first
        assert.equal(result.tabs[1].sId, 's2'); // A's tab second
    });

    test('multiple URL duplicates → correct counting', () => {
        // First state has 2 tabs with same URL, second state has 3
        // URL dedup should consume 2 from the counter, leaving 1
        const local = { tabs: [
            tab('s1', 'https://dup.com'),
            tab('s2', 'https://dup.com'),
            tab('s3', 'https://dup.com')
        ], groups: {}, peerId: 'A' };
        const remote = { tabs: [
            tab('s4', 'https://dup.com'),
            tab('s5', 'https://dup.com')
        ], groups: {}, peerId: 'B' };
        // B > A, so remote is first (2 tabs), local is second (3 tabs)
        // firstUrlCounts: dup.com|false → 2
        // second iterates 3 tabs: first 2 are deduped, third passes through
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.tabs.length, 3); // 2 from B + 1 leftover from A
    });

    test('overlapping groups → second state overwrites first for same key', () => {
        const local = { tabs: [], groups: { g1: { title: 'Old', color: 'blue' } }, peerId: 'A' };
        const remote = { tabs: [], groups: { g1: { title: 'New', color: 'red' } }, peerId: 'B' };
        // B > A → remote first, local second. mergedGroups = {...remote.groups, ...local.groups}
        // second overwrites first for same key
        const result = computeAtomicMerge(local, remote, 'A');
        assert.equal(result.groups.g1.title, 'Old'); // A (second) overwrites B (first)
    });

    test('handles missing groups gracefully', () => {
        const local = { tabs: [tab('s1', 'https://a.com')], peerId: 'A' };
        const remote = { tabs: [], peerId: 'B' };
        const result = computeAtomicMerge(local, remote, 'A');
        assert.deepEqual(result.groups, {});
        assert.equal(result.tabs.length, 1);
    });
});

// --- computeRemoteDiff ---

describe('computeRemoteDiff', () => {
    const tab = (sId, url, opts = {}) => ({ sId, url, pinned: false, muted: false, ...opts });

    test('empty prev, some remote tabs → all added', () => {
        const prev = new Map();
        const remote = [tab('s1', 'https://a.com'), tab('s2', 'https://b.com')];
        const diff = computeRemoteDiff(remote, prev);
        assert.equal(diff.added.length, 2);
        assert.equal(diff.updated.length, 0);
        assert.equal(diff.removed.length, 0);
    });

    test('same state → no changes', () => {
        const t = tab('s1', 'https://a.com');
        const prev = new Map([['s1', t]]);
        const diff = computeRemoteDiff([t], prev);
        assert.equal(diff.added.length, 0);
        assert.equal(diff.updated.length, 0);
        assert.equal(diff.removed.length, 0);
    });

    test('new tab added by remote → appears in added', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s2', 'https://b.com');
        const prev = new Map([['s1', t1]]);
        const diff = computeRemoteDiff([t1, t2], prev);
        assert.equal(diff.added.length, 1);
        assert.equal(diff.added[0].sId, 's2');
    });

    test('tab removed by remote → appears in removed', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s2', 'https://b.com');
        const prev = new Map([['s1', t1], ['s2', t2]]);
        const diff = computeRemoteDiff([t1], prev);
        assert.equal(diff.removed.length, 1);
        assert.equal(diff.removed[0], 's2');
    });

    test('URL changed → appears in updated with url', () => {
        const prev = new Map([['s1', tab('s1', 'https://old.com')]]);
        const remote = [tab('s1', 'https://new.com')];
        const diff = computeRemoteDiff(remote, prev);
        assert.equal(diff.updated.length, 1);
        assert.equal(diff.updated[0].sId, 's1');
        assert.equal(diff.updated[0].changes.url, 'https://new.com');
        assert.equal(diff.updated[0].changes.pinned, undefined);
    });

    test('pinned changed → appears in updated with pinned', () => {
        const prev = new Map([['s1', tab('s1', 'https://a.com', { pinned: false })]]);
        const remote = [tab('s1', 'https://a.com', { pinned: true })];
        const diff = computeRemoteDiff(remote, prev);
        assert.equal(diff.updated.length, 1);
        assert.equal(diff.updated[0].changes.pinned, true);
        assert.equal(diff.updated[0].changes.url, undefined);
    });

    test('muted changed → appears in updated with muted', () => {
        const prev = new Map([['s1', tab('s1', 'https://a.com', { muted: false })]]);
        const remote = [tab('s1', 'https://a.com', { muted: true })];
        const diff = computeRemoteDiff(remote, prev);
        assert.equal(diff.updated.length, 1);
        assert.equal(diff.updated[0].changes.muted, true);
    });

    test('multiple changes at once (add + update + remove)', () => {
        const t1 = tab('s1', 'https://a.com');
        const t2 = tab('s2', 'https://b.com');
        const prev = new Map([['s1', t1], ['s2', t2]]);

        const t1Updated = tab('s1', 'https://a-updated.com');
        const t3 = tab('s3', 'https://c.com');
        const diff = computeRemoteDiff([t1Updated, t3], prev);

        assert.equal(diff.added.length, 1);
        assert.equal(diff.added[0].sId, 's3');
        assert.equal(diff.updated.length, 1);
        assert.equal(diff.updated[0].sId, 's1');
        assert.equal(diff.updated[0].changes.url, 'https://a-updated.com');
        assert.equal(diff.removed.length, 1);
        assert.equal(diff.removed[0], 's2');
    });

    test('empty remote, some prev → all removed', () => {
        const prev = new Map([
            ['s1', tab('s1', 'https://a.com')],
            ['s2', tab('s2', 'https://b.com')]
        ]);
        const diff = computeRemoteDiff([], prev);
        assert.equal(diff.added.length, 0);
        assert.equal(diff.updated.length, 0);
        assert.equal(diff.removed.length, 2);
        assert.ok(diff.removed.includes('s1'));
        assert.ok(diff.removed.includes('s2'));
    });

    test('property unchanged → not in updated', () => {
        const t = tab('s1', 'https://a.com', { pinned: true, muted: true });
        const prev = new Map([['s1', t]]);
        // Same properties
        const remote = [tab('s1', 'https://a.com', { pinned: true, muted: true })];
        const diff = computeRemoteDiff(remote, prev);
        assert.equal(diff.updated.length, 0);
    });

    test('updated entries include tab reference', () => {
        const prev = new Map([['s1', tab('s1', 'https://old.com')]]);
        const rTab = tab('s1', 'https://new.com');
        const diff = computeRemoteDiff([rTab], prev);
        assert.equal(diff.updated[0].tab, rTab);
    });
});

// --- findMatchingLocalTab ---

describe('findMatchingLocalTab', () => {
    const localTab = (id, url, opts = {}) => ({
        id, url, pinned: false, index: 0, ...opts
    });

    test('exact match → returns tab', () => {
        const locals = [localTab(1, 'https://a.com', { index: 2 })];
        const remote = { url: 'https://a.com', pinned: false, index: 2 };
        const result = findMatchingLocalTab(locals, remote, new Set(), 3);
        assert.equal(result.id, 1);
    });

    test('URL mismatch → returns null', () => {
        const locals = [localTab(1, 'https://a.com')];
        const remote = { url: 'https://b.com', pinned: false, index: 0 };
        assert.equal(findMatchingLocalTab(locals, remote, new Set(), 3), null);
    });

    test('pinned mismatch → returns null', () => {
        const locals = [localTab(1, 'https://a.com', { pinned: true })];
        const remote = { url: 'https://a.com', pinned: false, index: 0 };
        assert.equal(findMatchingLocalTab(locals, remote, new Set(), 3), null);
    });

    test('index outside tolerance → returns null', () => {
        const locals = [localTab(1, 'https://a.com', { index: 10 })];
        const remote = { url: 'https://a.com', pinned: false, index: 0 };
        assert.equal(findMatchingLocalTab(locals, remote, new Set(), 3), null);
    });

    test('skips already-tracked tabs', () => {
        const locals = [localTab(1, 'https://a.com')];
        const remote = { url: 'https://a.com', pinned: false, index: 0 };
        const tracked = new Set([1]);
        assert.equal(findMatchingLocalTab(locals, remote, tracked, 3), null);
    });

    test('skips privileged URLs', () => {
        const locals = [localTab(1, 'moz-extension://foo')];
        const remote = { url: 'moz-extension://foo', pinned: false, index: 0 };
        assert.equal(findMatchingLocalTab(locals, remote, new Set(), 3), null);
    });

    test('about:blank remote → returns null (skipped)', () => {
        const locals = [localTab(1, 'about:blank')];
        const remote = { url: 'about:blank', pinned: false, index: 0 };
        assert.equal(findMatchingLocalTab(locals, remote, new Set(), 3), null);
    });

    test('no match in list → returns null', () => {
        const locals = [localTab(1, 'https://x.com'), localTab(2, 'https://y.com')];
        const remote = { url: 'https://z.com', pinned: false, index: 0 };
        assert.equal(findMatchingLocalTab(locals, remote, new Set(), 3), null);
    });
});

// --- buildTabGroupingMap ---

describe('buildTabGroupingMap', () => {
    test('empty inputs → empty map', () => {
        assert.deepEqual(buildTabGroupingMap([], {}, new Map()), {});
    });

    test('tabs without groups → empty map', () => {
        const tabs = [{ sId: 's1', url: 'https://a.com' }];
        assert.deepEqual(buildTabGroupingMap(tabs, {}, new Map()), {});
    });

    test('valid mapping → groups tabs by gSyncId', () => {
        const tabs = [
            { sId: 's1', groupSyncId: 'g1' },
            { sId: 's2', groupSyncId: 'g1' },
            { sId: 's3', groupSyncId: 'g2' }
        ];
        const groups = { g1: { title: 'A' }, g2: { title: 'B' } };
        const syncMap = new Map([['s1', 101], ['s2', 102], ['s3', 103]]);
        const result = buildTabGroupingMap(tabs, groups, syncMap);
        assert.deepEqual(result, { g1: [101, 102], g2: [103] });
    });

    test('nonexistent group ref → tab skipped', () => {
        const tabs = [{ sId: 's1', groupSyncId: 'g_missing' }];
        const groups = { g1: { title: 'A' } };
        const syncMap = new Map([['s1', 101]]);
        assert.deepEqual(buildTabGroupingMap(tabs, groups, syncMap), {});
    });

    test('unmapped syncId → tab not added to group', () => {
        const tabs = [{ sId: 's_unknown', groupSyncId: 'g1' }];
        const groups = { g1: { title: 'A' } };
        const syncMap = new Map(); // no mapping for s_unknown
        const result = buildTabGroupingMap(tabs, groups, syncMap);
        assert.deepEqual(result, { g1: [] });
    });
});

// --- matchTabsToMappings ---

describe('matchTabsToMappings', () => {
    const liveTab = (id, url, pinned = false) => ({ id, url, pinned });
    const mapping = (sId, url, pinned = false) => ({ sId, url, pinned });

    test('matches tabs by url+pinned', () => {
        const live = [liveTab(1, 'https://a.com'), liveTab(2, 'https://b.com')];
        const persisted = [mapping('s1', 'https://a.com'), mapping('s2', 'https://b.com')];
        const result = matchTabsToMappings(live, persisted);
        assert.equal(result.matched.length, 2);
        assert.equal(result.unmatched.length, 0);
        assert.deepEqual(result.matched[0], { tabId: 1, sId: 's1' });
        assert.deepEqual(result.matched[1], { tabId: 2, sId: 's2' });
    });

    test('returns unmatched persisted entries as tombstone candidates', () => {
        const live = [liveTab(1, 'https://a.com')];
        const persisted = [mapping('s1', 'https://a.com'), mapping('s2', 'https://gone.com')];
        const result = matchTabsToMappings(live, persisted);
        assert.equal(result.matched.length, 1);
        assert.equal(result.unmatched.length, 1);
        assert.equal(result.unmatched[0].sId, 's2');
        assert.equal(result.unmatched[0].url, 'https://gone.com');
    });

    test('handles multiple tabs with same URL (greedy matching)', () => {
        const live = [liveTab(1, 'https://a.com'), liveTab(2, 'https://a.com')];
        const persisted = [mapping('s1', 'https://a.com'), mapping('s2', 'https://a.com')];
        const result = matchTabsToMappings(live, persisted);
        assert.equal(result.matched.length, 2);
        assert.equal(result.unmatched.length, 0);
        // First mapping gets first live tab, second gets second
        assert.equal(result.matched[0].tabId, 1);
        assert.equal(result.matched[1].tabId, 2);
    });

    test('returns empty when no persisted mappings', () => {
        const live = [liveTab(1, 'https://a.com')];
        const result = matchTabsToMappings(live, []);
        assert.equal(result.matched.length, 0);
        assert.equal(result.unmatched.length, 0);
    });

    test('returns all unmatched when no live tabs', () => {
        const persisted = [mapping('s1', 'https://a.com'), mapping('s2', 'https://b.com')];
        const result = matchTabsToMappings([], persisted);
        assert.equal(result.matched.length, 0);
        assert.equal(result.unmatched.length, 2);
    });

    test('different pinned state prevents match', () => {
        const live = [liveTab(1, 'https://a.com', true)];
        const persisted = [mapping('s1', 'https://a.com', false)];
        const result = matchTabsToMappings(live, persisted);
        assert.equal(result.matched.length, 0);
        assert.equal(result.unmatched.length, 1);
    });

    test('each live tab matched at most once (no double-assignment)', () => {
        const live = [liveTab(1, 'https://a.com')];
        const persisted = [mapping('s1', 'https://a.com'), mapping('s2', 'https://a.com')];
        const result = matchTabsToMappings(live, persisted);
        assert.equal(result.matched.length, 1);
        assert.equal(result.unmatched.length, 1);
        assert.equal(result.matched[0].tabId, 1);
        assert.equal(result.matched[0].sId, 's1');
        assert.equal(result.unmatched[0].sId, 's2');
    });
});

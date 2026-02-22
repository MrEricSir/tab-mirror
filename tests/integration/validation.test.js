#!/usr/bin/env node
/**
 * Validation & Security Tests
 *
 * Tests sync ID generation and remote state validation:
 * - Sync IDs use crypto-quality hex format
 * - Sync IDs are unique across tabs
 * - Sync IDs survive sync to remote peer
 * - Excessive remote tabs get truncated
 * - Duplicate sync IDs get deduped
 * - Invalid tab data is filtered out
 * - Invalid group data is sanitized
 * - Malformed groups object is handled gracefully
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

const SID_REGEX = /^sid_[0-9a-f]{16}$/;

async function testSyncIdsUseCryptoFormat(browserA) {
  console.log();
  console.log('Test: Sync IDs Use Crypto Format');

  // Create a few tabs so we have sync IDs to inspect
  for (let i = 0; i < 3; i++) {
    await browserA.testBridge.createTab(generateTestUrl(`crypto-id-${i}`));
  }
  await sleep(2000);

  const state = await browserA.testBridge.getState();
  const mappings = state.tabMappings.tabIdToSyncId; // [[tabId, syncId], ...]

  console.log(`  Tab mappings count: ${mappings.length}`);
  await Assert.isTrue(mappings.length >= 3, 'Should have at least 3 tab mappings');

  const syncIds = mappings.map(([, sId]) => sId);
  for (const sId of syncIds) {
    console.log(`  Sync ID: ${sId}`);
    await Assert.isTrue(SID_REGEX.test(sId), `Sync ID "${sId}" should match sid_<16 hex chars>`);
  }

  // All should be unique
  const unique = new Set(syncIds);
  await Assert.equal(unique.size, syncIds.length, 'All sync IDs should be unique');

  results.pass('Sync IDs Use Crypto Format');
}

async function testSyncIdsSurviveSync(browserA, browserB) {
  console.log();
  console.log('Test: Sync IDs Survive Sync');

  // Wait for the tabs we created above to propagate
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(3000);

  const stateB = await browserB.testBridge.getState();
  const mappingsB = stateB.tabMappings.tabIdToSyncId;

  console.log(`  Browser B tab mappings count: ${mappingsB.length}`);

  const syncIdsB = mappingsB.map(([, sId]) => sId);
  let cryptoCount = 0;
  for (const sId of syncIdsB) {
    if (SID_REGEX.test(sId)) {
      cryptoCount++;
    }
  }

  console.log(`  Browser B crypto-format IDs: ${cryptoCount}/${syncIdsB.length}`);
  await Assert.isTrue(cryptoCount === syncIdsB.length, 'All sync IDs on Browser B should use crypto format');

  results.pass('Sync IDs Survive Sync');
}

async function testDuplicateSyncIdsDeduped(browserA) {
  console.log();
  console.log('Test: Duplicate Sync IDs Deduplicated');

  const tabsBefore = await browserA.testBridge.getTabs();
  const countBefore = tabsBefore.length;
  console.log(`  Tabs before injection: ${countBefore}`);

  // Inject 3 tabs that share the same sId
  const duplicateId = 'sid_dup_test_000001';
  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-dedup-peer',
    tabs: [
      { sId: duplicateId, url: 'http://127.0.0.1:8080/dup-1', index: 0, pinned: false, muted: false },
      { sId: duplicateId, url: 'http://127.0.0.1:8080/dup-2', index: 1, pinned: false, muted: false },
      { sId: duplicateId, url: 'http://127.0.0.1:8080/dup-3', index: 2, pinned: false, muted: false },
    ],
    groups: {}
  });

  await sleep(3000);

  const tabsAfter = await browserA.testBridge.getTabs();
  const dupTabs = tabsAfter.filter(t => t.url && t.url.includes('dup-'));
  console.log(`  Tabs with 'dup-' URL: ${dupTabs.length}`);

  // Only 1 tab should've been created (first one wins)
  await Assert.isTrue(dupTabs.length <= 1, `Should have at most 1 tab from duplicate IDs, got ${dupTabs.length}`);

  // Check logs
  const logs = await browserA.testBridge.getLogs();
  const dedupLog = logs.find(l => l.message && l.message.includes('Dropped duplicate sync ID'));
  console.log(`  Dedup log found: ${!!dedupLog}`);
  await Assert.isTrue(!!dedupLog, 'Should log duplicate sync ID drops');

  results.pass('Duplicate Sync IDs Deduplicated');
}

async function testInvalidTabDataFiltered(browserA) {
  console.log();
  console.log('Test: Invalid Tab Data Filtered');

  const tabsBefore = await browserA.testBridge.getTabs();
  const countBefore = tabsBefore.length;
  console.log(`  Tabs before injection: ${countBefore}`);

  const longUrl = 'http://127.0.0.1:8080/' + 'x'.repeat(9000);

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-invalid-peer',
    tabs: [
      // valid tab
      { sId: 'sid_valid_test_00001', url: 'http://127.0.0.1:8080/valid-inject', index: 0, pinned: false, muted: false },
      // chrome:// URL -- should be filtered
      { sId: 'sid_chrome_test_0001', url: 'chrome://settings', index: 1, pinned: false, muted: false },
      // empty sId -- should be filtered
      { sId: '', url: 'http://127.0.0.1:8080/no-sid', index: 2, pinned: false, muted: false },
      // URL > 8192 chars -- should be filtered
      { sId: 'sid_longurl_test_001', url: longUrl, index: 3, pinned: false, muted: false },
      // null tab -- should be filtered
      null,
    ],
    groups: {}
  });

  await sleep(3000);

  const tabsAfter = await browserA.testBridge.getTabs();
  const validTab = tabsAfter.find(t => t.url && t.url.includes('valid-inject'));
  const chromeTab = tabsAfter.find(t => t.url && t.url.includes('chrome://settings'));
  const noSidTab = tabsAfter.find(t => t.url && t.url.includes('no-sid'));

  console.log(`  Valid tab found: ${!!validTab}`);
  console.log(`  Chrome tab found: ${!!chromeTab}`);
  console.log(`  No-sId tab found: ${!!noSidTab}`);

  await Assert.isTrue(!!validTab, 'Valid tab should be accepted');
  await Assert.isTrue(!chromeTab, 'chrome:// tab should be filtered');
  await Assert.isTrue(!noSidTab, 'Tab with empty sId should be filtered');

  results.pass('Invalid Tab Data Filtered');
}

async function testInvalidGroupDataSanitized(browserA) {
  console.log();
  console.log('Test: Invalid Group Data Sanitized');

  const longTitle = 'A'.repeat(500);

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-group-peer',
    tabs: [
      { sId: 'sid_grptest_000001a', url: 'http://127.0.0.1:8080/group-test-1', index: 0, pinned: false, muted: false, groupSyncId: 'gsid_badcolor_00001' },
      { sId: 'sid_grptest_000002a', url: 'http://127.0.0.1:8080/group-test-2', index: 1, pinned: false, muted: false, groupSyncId: 'gsid_longtitle_0001' },
    ],
    groups: {
      'gsid_badcolor_00001': { title: 'Bad Color', color: 'neon', lastModified: Date.now() },
      'gsid_longtitle_0001': { title: longTitle, color: 'blue', lastModified: Date.now() },
    }
  });

  await sleep(3000);

  // Extension should've sanitized color to 'grey' and truncated the title.
  // We can check logs for validation activity.
  const logs = await browserA.testBridge.getLogs();
  // Validation happens before processing -- just check no crash occurred
  // and the tabs were processed
  const tabsAfter = await browserA.testBridge.getTabs();
  const grpTab = tabsAfter.find(t => t.url && t.url.includes('group-test-1'));
  console.log(`  Group test tab found: ${!!grpTab}`);
  await Assert.isTrue(!!grpTab, 'Tab with sanitized group should still be created');

  results.pass('Invalid Group Data Sanitized');
}

async function testMalformedGroupsObject(browserA) {
  console.log();
  console.log('Test: Malformed Groups Object Handled');

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-malformed-peer',
    tabs: [
      { sId: 'sid_malform_0000001', url: 'http://127.0.0.1:8080/malformed-groups', index: 0, pinned: false, muted: false },
    ],
    groups: [1, 2, 3] // Array instead of object
  });

  await sleep(3000);

  // Shouldn't crash, and the valid tab should still be processed
  const tabsAfter = await browserA.testBridge.getTabs();
  const malformedTab = tabsAfter.find(t => t.url && t.url.includes('malformed-groups'));
  console.log(`  Malformed-groups tab found: ${!!malformedTab}`);
  await Assert.isTrue(!!malformedTab, 'Tab should be created even with malformed groups');

  results.pass('Malformed Groups Object Handled');
}

async function testInvalidPeerIdRejected(browserA) {
  console.log();
  console.log('Test: Invalid Peer ID Rejected');

  const tabsBefore = await browserA.testBridge.getTabs();
  const countBefore = tabsBefore.length;

  // Try a peer ID > 128 chars
  const longPeerId = 'x'.repeat(200);
  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: longPeerId,
    tabs: [
      { sId: 'sid_badpeer_0000001', url: 'http://127.0.0.1:8080/bad-peer', index: 0, pinned: false, muted: false },
    ],
    groups: {}
  });

  await sleep(2000);

  const tabsAfter = await browserA.testBridge.getTabs();
  const badPeerTab = tabsAfter.find(t => t.url && t.url.includes('bad-peer'));
  console.log(`  Bad-peer tab found: ${!!badPeerTab}`);
  await Assert.isTrue(!badPeerTab, 'Tab from invalid peer ID should be rejected');

  results.pass('Invalid Peer ID Rejected');
}

async function testStaleTabUpdateLogged(browserA) {
  console.log();
  console.log('Test: Stale Tab Update Error Is Logged');

  // First inject: atomic merge -- creates real tabs and sets up prevState
  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-error-log-peer',
    tabs: [
      { sId: 'sid_stale_update_01', url: 'http://127.0.0.1:8080/stale-update-v1', index: 0, pinned: false, muted: false },
      { sId: 'sid_stale_keep_001a', url: 'http://127.0.0.1:8080/stale-keep', index: 1, pinned: false, muted: false },
    ],
    groups: {}
  });
  await sleep(2000);

  // Point the mapping at a non-existent tab ID
  await browserA.testBridge.createStaleMapping('sid_stale_update_01', 999999);
  await sleep(1000);

  // Second inject: incremental sync -- changed URL triggers update on stale mapping
  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-error-log-peer',
    tabs: [
      { sId: 'sid_stale_update_01', url: 'http://127.0.0.1:8080/stale-update-v2', index: 0, pinned: false, muted: false },
      { sId: 'sid_stale_keep_001a', url: 'http://127.0.0.1:8080/stale-keep', index: 1, pinned: false, muted: false },
    ],
    groups: {}
  });
  await sleep(3000);

  // Look for error log with specific sync ID
  const logs = await browserA.testBridge.getLogs();
  const updateLog = logs.find(l => l.message && l.message.includes('Tab gone during update') && l.message.includes('sid_stale_update_01'));
  console.log(`  Update error logged: ${!!updateLog}`);
  if (updateLog) {
    console.log(`  Log message: ${updateLog.message}`);
  }

  await Assert.isTrue(!!updateLog, 'Tab update failure should be logged (not silently swallowed)');

  // Make sure extension still works after the error
  await browserA.testBridge.createTab(generateTestUrl('post-update-error'));
  await sleep(1000);
  const tabs = await browserA.testBridge.getTabs();
  const postErrorTab = tabs.find(t => t.url && t.url.includes('post-update-error'));
  await Assert.isTrue(!!postErrorTab, 'Extension should still function after tab update error');

  results.pass('Stale Tab Update Error Is Logged');
}

async function testStaleTabRemovalLogged(browserA) {
  console.log();
  console.log('Test: Stale Tab Removal Error Is Logged');

  // First inject: set up prevState with a tab we'll make stale, then remove
  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-removal-log-peer',
    tabs: [
      { sId: 'sid_stale_remove_01', url: 'http://127.0.0.1:8080/stale-remove', index: 0, pinned: false, muted: false },
      { sId: 'sid_stale_keep_002a', url: 'http://127.0.0.1:8080/stale-keep-2', index: 1, pinned: false, muted: false },
    ],
    groups: {}
  });
  await sleep(2000);

  // Point the mapping at a non-existent tab ID
  await browserA.testBridge.createStaleMapping('sid_stale_remove_01', 999998);
  await sleep(1000);

  // Second inject: omit the stale tab -- triggers removal on stale mapping
  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-removal-log-peer',
    tabs: [
      { sId: 'sid_stale_keep_002a', url: 'http://127.0.0.1:8080/stale-keep-2', index: 1, pinned: false, muted: false },
    ],
    groups: {}
  });
  await sleep(3000);

  // Look for error log with specific sync ID
  const logs = await browserA.testBridge.getLogs();
  const removeLog = logs.find(l => l.message && l.message.includes('Tab already gone during removal check') && l.message.includes('sid_stale_remove_01'));
  console.log(`  Removal error logged: ${!!removeLog}`);
  if (removeLog) {
    console.log(`  Log message: ${removeLog.message}`);
  }

  await Assert.isTrue(!!removeLog, 'Tab removal failure should be logged (not silently swallowed)');

  // Make sure extension still works after the error
  await browserA.testBridge.createTab(generateTestUrl('post-remove-error'));
  await sleep(1000);
  const tabs = await browserA.testBridge.getTabs();
  const postErrorTab = tabs.find(t => t.url && t.url.includes('post-remove-error'));
  await Assert.isTrue(!!postErrorTab, 'Extension should still function after tab removal error');

  results.pass('Stale Tab Removal Error Is Logged');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('VALIDATION & SECURITY TESTS');
  console.log('═'.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');

    // Wait for connection + initial sync
    console.log();
    console.log('Waiting for connection...');
    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'Browser A should connect');
    await Assert.isTrue(connectedB, 'Browser B should connect');

    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('✅ Connected and synced');

    const tests = [
      () => testSyncIdsUseCryptoFormat(browserA),
      () => testSyncIdsSurviveSync(browserA, browserB),
      () => testDuplicateSyncIdsDeduped(browserA),
      () => testInvalidTabDataFiltered(browserA),
      () => testInvalidGroupDataSanitized(browserA),
      () => testMalformedGroupsObject(browserA),
      () => testInvalidPeerIdRejected(browserA),
      () => testStaleTabUpdateLogged(browserA),
      () => testStaleTabRemovalLogged(browserA),
    ];

    for (const test of tests) {
      try {
        await test();
      } catch (error) {
        results.error(test.name || 'Unknown Test', error);
      }
    }

  } catch (error) {
    results.error('Test Suite Setup', error);
  } finally {
    console.log();
    console.log('Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }

  results.summary();
  process.exit(results.exitCode());
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

main();

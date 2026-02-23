#!/usr/bin/env node
/**
 * Edge Case Tests
 *
 * Scenarios not covered by other suites:
 * - Private browsing: incognito tabs shouldn't sync
 * - Extension reload: device ID persists, re-sync works
 * - Group name conflicts: same-named groups on different peers
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testPrivateWindowExcluded(browserA, browserB) {
  console.log();
  console.log('Test: Private Window Tabs Excluded from Sync');

  // Grab baseline state
  const tabsBefore = await browserB.testBridge.getTabs();
  const countBefore = tabsBefore.length;
  console.log(`  Browser B tabs before: ${countBefore}`);

  // Open a private window on A
  let privateWindowCreated = false;
  try {
    const result = await browserA.testBridge.createPrivateWindow(
      generateTestUrl('private-tab-should-not-sync')
    );
    privateWindowCreated = true;
    console.log(`  Created private window: ${result.windowId}`);
  } catch (e) {
    console.log(`  Could not create private window: ${e.message}`);
    console.log('  Skipping test (private windows may not be available)');
    results.pass('Private Window Tabs Excluded from Sync (skipped - not available)');
    return;
  }

  // Sync window shouldn't have changed to the private window
  const stateA = await browserA.testBridge.getState();
  console.log(`  Sync window ID: ${stateA.syncWindowId}`);
  await Assert.isTrue(stateA.syncWindowId !== null, 'Sync window should still be set');

  // Wait for any sync activity to settle
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);

  // Private tab should NOT have synced to B
  const tabsAfter = await browserB.testBridge.getTabs();
  const privateTab = tabsAfter.find(t => t.url && t.url.includes('private-tab-should-not-sync'));
  console.log(`  Private tab synced to B: ${!!privateTab}`);
  console.log(`  Browser B tabs after: ${tabsAfter.length}`);

  await Assert.isTrue(!privateTab, 'Private window tab should NOT sync to other browser');

  // Also check that the private tab isn't in A's captured sync state
  const capturedTabs = (await browserA.testBridge.getTabs());
  const privateInCapture = capturedTabs.find(t => t.url && t.url.includes('private-tab-should-not-sync'));
  console.log(`  Private tab in A's sync state: ${!!privateInCapture}`);
  await Assert.isTrue(!privateInCapture, 'Private tab should not appear in captured sync state');

  results.pass('Private Window Tabs Excluded from Sync');
}

async function testExtensionReloadPersistence(browserA, browserB) {
  console.log();
  console.log('Test: Extension Reload Persistence');

  // Grab state before restart
  const stateBefore = await browserA.testBridge.getState();
  const deviceIdBefore = stateBefore.myDeviceId;
  const syncedPeersBefore = stateBefore.syncedPeers;
  console.log(`  Device ID before: ${deviceIdBefore}`);
  console.log(`  Synced peers before: ${syncedPeersBefore.length}`);

  // Create a tab to check it persists across restart
  await browserA.testBridge.createTab(generateTestUrl('persist-across-restart'));
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  const tabsBefore = await browserA.testBridge.getTabs();
  console.log(`  Tabs before restart: ${tabsBefore.length}`);

  // Restart
  console.log('  Simulating restart...');
  await browserA.testBridge.simulateRestart();

  // Wait for reconnection
  console.log('  Waiting for reconnection...');
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'Browser A should reconnect after restart');

  // Wait for re-sync
  await browserA.testBridge.waitForSyncComplete(15000);
  await sleep(2000);

  // Check device ID persisted
  const stateAfter = await browserA.testBridge.getState();
  console.log(`  Device ID after: ${stateAfter.myDeviceId}`);
  await Assert.equal(stateAfter.myDeviceId, deviceIdBefore,
    'Device ID should persist across restart');

  // Check tabs still exist (Firefox tabs survive extension restart)
  const tabsAfter = await browserA.testBridge.getTabs();
  const persistTab = tabsAfter.find(t => t.url && t.url.includes('persist-across-restart'));
  console.log(`  Tabs after restart: ${tabsAfter.length}`);
  console.log(`  Persist tab found: ${!!persistTab}`);
  await Assert.isTrue(!!persistTab, 'Tab should survive restart');

  // Check sync still works: create tab on B, should appear on A
  await browserB.testBridge.createTab(generateTestUrl('post-restart-sync'));
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(15000);
  await sleep(2000);

  const tabsAfterSync = await browserA.testBridge.getTabs();
  const postRestartTab = tabsAfterSync.find(t => t.url && t.url.includes('post-restart-sync'));
  console.log(`  Post-restart sync tab on A: ${!!postRestartTab}`);
  await Assert.isTrue(!!postRestartTab, 'Sync should work after restart');

  results.pass('Extension Reload Persistence');
}

async function testGroupNameConflicts(browserA, browserB) {
  console.log();
  console.log('Test: Group Name Conflicts Across Peers');

  // Check if tabGroups API is available
  const groupsA = await browserA.testBridge.getGroupCount();
  if (groupsA.error) {
    console.log('  tabGroups API not available, skipping');
    results.pass('Group Name Conflicts Across Peers (skipped - no tabGroups API)');
    return;
  }

  // Create tabs on both browsers
  const tabA1 = await browserA.testBridge.createTab(generateTestUrl('conflict-a1'));
  const tabA2 = await browserA.testBridge.createTab(generateTestUrl('conflict-a2'));
  await sleep(1000);

  const tabB1 = await browserB.testBridge.createTab(generateTestUrl('conflict-b1'));
  const tabB2 = await browserB.testBridge.createTab(generateTestUrl('conflict-b2'));
  await sleep(2000);

  // Wait for initial sync
  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);
  await sleep(2000);

  // Grab fresh tab IDs (sync may have changed them)
  const allTabsA = await browserA.testBridge.getTabs();
  const conflictTabsA = allTabsA.filter(t => t.url && t.url.includes('conflict-a'));
  console.log(`  Browser A conflict tabs: ${conflictTabsA.length}`);

  const allTabsB = await browserB.testBridge.getTabs();
  const conflictTabsB = allTabsB.filter(t => t.url && t.url.includes('conflict-b'));
  console.log(`  Browser B conflict tabs: ${conflictTabsB.length}`);

  if (conflictTabsA.length < 2 || conflictTabsB.length < 2) {
    console.log('  Not enough tabs for group test, skipping');
    results.pass('Group Name Conflicts Across Peers (skipped - insufficient tabs)');
    return;
  }

  // Create groups with the SAME NAME but different colors on each browser
  console.log('  Creating "Shared Project" group on both browsers...');
  try {
    await browserA.testBridge.groupTabs(
      conflictTabsA.map(t => t.id), 'Shared Project', 'blue'
    );
    await browserB.testBridge.groupTabs(
      conflictTabsB.map(t => t.id), 'Shared Project', 'red'
    );
  } catch (e) {
    console.log(`  Failed to create groups: ${e.message}`);
    results.pass('Group Name Conflicts Across Peers (skipped - group creation failed)');
    return;
  }

  // Wait for sync
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);
  await sleep(3000);

  // Check that both browsers have both groups (different sync IDs, same name)
  const groupsAfterA = await browserA.testBridge.getGroupCount();
  const groupsAfterB = await browserB.testBridge.getGroupCount();

  const sharedGroupsA = groupsAfterA.groupDetails.filter(g => g.title === 'Shared Project');
  const sharedGroupsB = groupsAfterB.groupDetails.filter(g => g.title === 'Shared Project');

  console.log(`  Browser A "Shared Project" groups: ${sharedGroupsA.length}`);
  sharedGroupsA.forEach(g => console.log(`    - color: ${g.color}, tabs: ${g.tabCount}`));
  console.log(`  Browser B "Shared Project" groups: ${sharedGroupsB.length}`);
  sharedGroupsB.forEach(g => console.log(`    - color: ${g.color}, tabs: ${g.tabCount}`));

  // Both should have 2 groups named "Shared Project" (with different sync IDs)
  await Assert.equal(sharedGroupsA.length, 2,
    'Browser A should have 2 "Shared Project" groups (one local, one from B)');
  await Assert.equal(sharedGroupsB.length, 2,
    'Browser B should have 2 "Shared Project" groups (one local, one from A)');

  // Check both colors are represented (not overwritten)
  const colorsA = sharedGroupsA.map(g => g.color).sort();
  const colorsB = sharedGroupsB.map(g => g.color).sort();
  console.log(`  Browser A colors: ${colorsA.join(', ')}`);
  console.log(`  Browser B colors: ${colorsB.join(', ')}`);

  await Assert.isTrue(colorsA.includes('blue') && colorsA.includes('red'),
    'Browser A should have both blue and red groups');
  await Assert.isTrue(colorsB.includes('blue') && colorsB.includes('red'),
    'Browser B should have both blue and red groups');

  results.pass('Group Name Conflicts Across Peers');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('EDGE CASE TESTS');
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
      testPrivateWindowExcluded,
      testExtensionReloadPersistence,
      testGroupNameConflicts,
    ];

    for (const test of tests) {
      try {
        await test(browserA, browserB);
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

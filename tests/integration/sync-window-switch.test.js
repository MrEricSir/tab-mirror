#!/usr/bin/env node
/**
 * Sync Window Switch Merge Tests
 *
 * Verifies that manually switching the sync window correctly merges tabs on 
 * the peer.
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

/**
 * Helper: get syncable tab URLs (exclude testbridge-init and about: pages)
 */
function getSyncableUrls(tabs) {
  return tabs
    .filter(t => t.url && !t.url.includes('testbridge-init') && !t.url.startsWith('about:'))
    .map(t => t.url)
    .sort();
}

/**
 * Test: Switching sync window merges tabs on peer
 *
 * Setup: A and B are synced. A's sync window has tabs [T1, T2].
 * Action: Open a second window on A with [T3], then switch sync to that window.
 * Expected: B should have [T1, T2, T3] with all tabs merged.
 * Bug: B ends up with only [T3] because old tabs are removed.
 */
async function testSwitchWindowMergesTabs(browserA, browserB) {
  console.log();
  console.log('Test: Switching Sync Window Merges Tabs on Peer');

  const originalSyncWindowId = await browserA.testBridge.getSyncWindowId();
  console.log(`  Original sync window: ${originalSyncWindowId}`);

  // Create distinctive tabs in A's current sync window
  const url1 = generateTestUrl('merge-original-1');
  const url2 = generateTestUrl('merge-original-2');
  await browserA.testBridge.createTab(url1);
  await browserA.testBridge.createTab(url2);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Wait for both tabs to appear on B
  const foundUrl1 = await browserB.testBridge.waitForTabUrl('merge-original-1', 20000);
  const foundUrl2 = await browserB.testBridge.waitForTabUrl('merge-original-2', 20000);
  await Assert.isTrue(!!foundUrl1, 'B should have merge-original-1');
  await Assert.isTrue(!!foundUrl2, 'B should have merge-original-2');

  const tabsBBefore = await browserB.testBridge.getTabs();
  const urlsBBefore = getSyncableUrls(tabsBBefore);
  console.log(`  B tabs before switch: ${urlsBBefore.length} syncable`);
  urlsBBefore.forEach(u => console.log(`    ${u}`));

  // Open a second window on A with a new tab
  const url3 = generateTestUrl('merge-newwin-1');
  console.log(`  Creating second window on A with: ${url3}`);
  const newWindow = await browserA.testBridge.createWindow(url3);
  console.log(`  New window ID: ${newWindow.id}`);
  await sleep(2000);

  // Switch sync to the new window
  console.log(`  Switching sync window from ${originalSyncWindowId} to ${newWindow.id}...`);
  await browserA.testBridge.adoptSyncWindow(newWindow.id);

  // Wait for sync to propagate
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Extra time for sync to settle
  await sleep(5000);

  // Check B's tabs -- should have ALL tabs (original + new window)
  const tabsBAfter = await browserB.testBridge.getTabs();
  const urlsBAfter = getSyncableUrls(tabsBAfter);
  console.log(`  B tabs after switch: ${urlsBAfter.length} syncable`);
  urlsBAfter.forEach(u => console.log(`    ${u}`));

  // The new window's tab must be present
  const hasNewTab = urlsBAfter.some(u => u.includes('merge-newwin-1'));
  console.log(`  B has new window tab (merge-newwin-1): ${hasNewTab}`);
  await Assert.isTrue(hasNewTab, 'B should have the new window tab');

  // The OLD window's tabs must ALSO still be present (this is the bug)
  const hasOldTab1 = urlsBAfter.some(u => u.includes('merge-original-1'));
  const hasOldTab2 = urlsBAfter.some(u => u.includes('merge-original-2'));
  console.log(`  B still has merge-original-1: ${hasOldTab1}`);
  console.log(`  B still has merge-original-2: ${hasOldTab2}`);

  await Assert.isTrue(hasOldTab1, 'B should still have merge-original-1 after sync window switch');
  await Assert.isTrue(hasOldTab2, 'B should still have merge-original-2 after sync window switch');

  // Clean up: close extra window
  try {
    await browserA.testBridge.closeWindow(newWindow.id);
  } catch (e) {
    // may fail during cleanup
  }
  await sleep(1000);

  results.pass('Switching Sync Window Merges Tabs on Peer');
}

/**
 * Test: Switching back to original window doesn't duplicate tabs
 *
 * After switching to a new window and back, B should not get duplicate
 * tabs from the original window.
 */
async function testSwitchBackNoDuplicates(browserA, browserB) {
  console.log();
  console.log('Test: Switching Back to Original Window No Duplicates');

  const originalSyncWindowId = await browserA.testBridge.getSyncWindowId();
  console.log(`  Current sync window: ${originalSyncWindowId}`);

  // Create a tab in the current sync window
  const url1 = generateTestUrl('nodup-original');
  await browserA.testBridge.createTab(url1);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForTabUrl('nodup-original', 20000);

  // Count how many nodup-original tabs B has
  let tabsB = await browserB.testBridge.getTabs();
  const countBefore = tabsB.filter(t => t.url && t.url.includes('nodup-original')).length;
  console.log(`  B has ${countBefore} nodup-original tab(s) before switch`);
  await Assert.equal(countBefore, 1, 'Should have exactly 1 nodup-original tab before');

  // Open second window, switch to it, then switch back
  const newWindow = await browserA.testBridge.createWindow(generateTestUrl('nodup-detour'));
  console.log(`  Created detour window: ${newWindow.id}`);
  await sleep(1000);

  console.log(`  Switching to detour window...`);
  await browserA.testBridge.adoptSyncWindow(newWindow.id);
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  console.log(`  Switching back to original window ${originalSyncWindowId}...`);
  await browserA.testBridge.adoptSyncWindow(originalSyncWindowId);
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await sleep(5000);

  // B should still have exactly 1 copy of nodup-original, not 2
  tabsB = await browserB.testBridge.getTabs();
  const countAfter = tabsB.filter(t => t.url && t.url.includes('nodup-original')).length;
  console.log(`  B has ${countAfter} nodup-original tab(s) after switch-back`);

  await Assert.equal(countAfter, 1, 'Should still have exactly 1 nodup-original tab after switching back');

  // Clean up
  try {
    await browserA.testBridge.closeWindow(newWindow.id);
  } catch (e) {
    // may fail
  }
  await sleep(1000);

  results.pass('Switching Back to Original Window No Duplicates');
}

/**
 * Test: Multiple tabs in both windows merge correctly
 *
 * A's sync window has [T1, T2]. A's second window has [T3, T4].
 * Switch sync to second window. B should have [T1, T2, T3, T4].
 */
async function testMultipleTabsBothWindowsMerge(browserA, browserB) {
  console.log();
  console.log('Test: Multiple Tabs in Both Windows Merge Correctly');

  // Clean start: figure out current state
  const syncWindowId = await browserA.testBridge.getSyncWindowId();

  // Create 2 tabs in sync window
  const syncUrl1 = generateTestUrl('multi-sync-1');
  const syncUrl2 = generateTestUrl('multi-sync-2');
  await browserA.testBridge.createTab(syncUrl1);
  await browserA.testBridge.createTab(syncUrl2);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForTabUrl('multi-sync-1', 20000);
  await browserB.testBridge.waitForTabUrl('multi-sync-2', 20000);

  // Create second window with 2 tabs
  const newWinUrl1 = generateTestUrl('multi-newwin-1');
  const newWindow = await browserA.testBridge.createWindow(newWinUrl1);
  await sleep(1000);

  // Create a second tab in the new window
  // (createTab creates in the sync window, so use createWindow's tab + add another)
  // The new window already has 1 tab from createWindow.
  console.log(`  Sync window tabs: multi-sync-1, multi-sync-2`);
  console.log(`  New window tab: multi-newwin-1`);

  // Switch sync to the new window
  console.log(`  Switching sync to new window ${newWindow.id}...`);
  await browserA.testBridge.adoptSyncWindow(newWindow.id);

  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await sleep(5000);

  const tabsB = await browserB.testBridge.getTabs();
  const urlsB = getSyncableUrls(tabsB);
  console.log(`  B tabs after switch: ${urlsB.length} syncable`);
  urlsB.forEach(u => console.log(`    ${u}`));

  // New window tab should be there
  const hasNewWin1 = urlsB.some(u => u.includes('multi-newwin-1'));
  console.log(`  B has multi-newwin-1: ${hasNewWin1}`);
  await Assert.isTrue(hasNewWin1, 'B should have multi-newwin-1');

  // Old sync window tabs should ALSO still be there
  const hasSync1 = urlsB.some(u => u.includes('multi-sync-1'));
  const hasSync2 = urlsB.some(u => u.includes('multi-sync-2'));
  console.log(`  B has multi-sync-1: ${hasSync1}`);
  console.log(`  B has multi-sync-2: ${hasSync2}`);

  await Assert.isTrue(hasSync1, 'B should still have multi-sync-1 after switch');
  await Assert.isTrue(hasSync2, 'B should still have multi-sync-2 after switch');

  // Clean up
  try {
    await browserA.testBridge.closeWindow(newWindow.id);
  } catch (e) {
    // may fail
  }
  await sleep(1000);

  results.pass('Multiple Tabs in Both Windows Merge Correctly');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('SYNC WINDOW SWITCH MERGE TESTS');
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

    // Run tests -- order matters since some tests leave state
    const tests = [
      testSwitchWindowMergesTabs,
      testSwitchBackNoDuplicates,
      testMultipleTabsBothWindowsMerge,
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

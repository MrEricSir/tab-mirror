#!/usr/bin/env node
/**
 * Tab Movement Tests
 *
 * Tests cross-window tab movement via the onDetached/onAttached handlers:
 * - Tab moved out of sync window is removed from peer
 * - Tab moved into sync window appears on peer
 * - Tab moved out and back re-appears on peer
 * - Rapid movement of multiple tabs settles correctly
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testTabMovedOutRemovedFromPeer(browserA, browserB) {
  console.log();
  console.log('Test: Tab Moved Out Is Removed From Peer');

  // Create a tab in A's sync window
  const url = generateTestUrl('moveout-tab');
  const tab = await browserA.testBridge.createTab(url);
  await sleep(1000);

  // Verify it syncs to B
  const found = await browserB.testBridge.waitForTabUrl('moveout-tab', 20000);
  await Assert.isTrue(!!found, 'B should have moveout-tab before move');

  // Create a second window to move the tab into
  const otherWindow = await browserA.testBridge.createWindow(generateTestUrl('moveout-other'));
  await sleep(500);

  // Move the tab out of the sync window
  console.log(`  Moving tab ${tab.id} to window ${otherWindow.id}...`);
  await browserA.testBridge.moveTabToWindow(tab.id, otherWindow.id);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await sleep(1000);

  // Verify B no longer has the tab
  const tabsB = await browserB.testBridge.getTabs();
  const stillThere = tabsB.find(t => t.url && t.url.includes('moveout-tab'));
  console.log(`  B still has moveout-tab: ${!!stillThere}`);
  await Assert.isTrue(!stillThere, 'B should NOT have moveout-tab after it was moved out');

  // Clean up
  try {
    await browserA.testBridge.closeWindow(otherWindow.id);
  } catch (e) {
    // may fail
  }
  await sleep(500);

  results.pass('Tab Moved Out Is Removed From Peer');
}

async function testTabMovedInAppearsOnPeer(browserA, browserB) {
  console.log();
  console.log('Test: Tab Moved In Appears on Peer');

  const syncWindowId = await browserA.testBridge.getSyncWindowId();

  // Create a second window with a tab
  const url = generateTestUrl('movein-tab');
  const otherWindow = await browserA.testBridge.createWindow(url);
  await sleep(1000);

  // The tab is NOT in the sync window, so B should not have it
  let tabsB = await browserB.testBridge.getTabs();
  let hasIt = tabsB.find(t => t.url && t.url.includes('movein-tab'));
  console.log(`  B has movein-tab before move: ${!!hasIt}`);
  await Assert.isTrue(!hasIt, 'B should NOT have movein-tab before it is moved in');

  // Find the tab ID (getTabs returns all tabs across all windows)
  const allTabs = await browserA.testBridge.getTabs();
  const tabToMove = allTabs.find(t => t.url && t.url.includes('movein-tab'));
  await Assert.isTrue(!!tabToMove, 'Should find movein-tab in other window');

  // Move it into the sync window
  console.log(`  Moving tab ${tabToMove.id} to sync window ${syncWindowId}...`);
  await browserA.testBridge.moveTabToWindow(tabToMove.id, syncWindowId);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Verify B now has the tab
  const found = await browserB.testBridge.waitForTabUrl('movein-tab', 15000);
  console.log(`  B has movein-tab after move: ${!!found}`);
  await Assert.isTrue(!!found, 'B should have movein-tab after it was moved in');

  // Clean up
  try {
    await browserA.testBridge.closeWindow(otherWindow.id);
  } catch (e) {
    // may fail
  }
  await sleep(500);

  results.pass('Tab Moved In Appears on Peer');
}

async function testTabMovedOutAndBack(browserA, browserB) {
  console.log();
  console.log('Test: Tab Moved Out and Back');

  const syncWindowId = await browserA.testBridge.getSyncWindowId();

  // Create a tab in the sync window
  const url = generateTestUrl('bounce-tab');
  const tab = await browserA.testBridge.createTab(url);
  await sleep(1000);

  // Verify it syncs to B
  const found = await browserB.testBridge.waitForTabUrl('bounce-tab', 20000);
  await Assert.isTrue(!!found, 'B should have bounce-tab initially');

  // Create second window and move tab out
  const otherWindow = await browserA.testBridge.createWindow(generateTestUrl('bounce-other'));
  await sleep(500);

  console.log(`  Moving tab out...`);
  await browserA.testBridge.moveTabToWindow(tab.id, otherWindow.id);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await sleep(1000);

  // Verify B lost the tab
  let tabsB = await browserB.testBridge.getTabs();
  let hasIt = tabsB.find(t => t.url && t.url.includes('bounce-tab'));
  console.log(`  B has bounce-tab after move out: ${!!hasIt}`);
  await Assert.isTrue(!hasIt, 'B should NOT have bounce-tab after move out');

  // Move it back in
  console.log(`  Moving tab back in...`);
  await browserA.testBridge.moveTabToWindow(tab.id, syncWindowId);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Verify B has it again
  const reappeared = await browserB.testBridge.waitForTabUrl('bounce-tab', 15000);
  console.log(`  B has bounce-tab after move back: ${!!reappeared}`);
  await Assert.isTrue(!!reappeared, 'B should have bounce-tab after it was moved back');

  // Clean up
  try {
    await browserA.testBridge.closeWindow(otherWindow.id);
  } catch (e) {
    // may fail
  }
  await sleep(500);

  results.pass('Tab Moved Out and Back');
}

async function testRapidMovementOfMultipleTabs(browserA, browserB) {
  console.log();
  console.log('Test: Rapid Movement of Multiple Tabs');

  const syncWindowId = await browserA.testBridge.getSyncWindowId();

  // Create 3 tabs in the sync window
  const urls = ['rapid-1', 'rapid-2', 'rapid-3'];
  const tabs = [];
  for (const tag of urls) {
    const tab = await browserA.testBridge.createTab(generateTestUrl(tag));
    tabs.push(tab);
  }
  await sleep(1000);

  // Verify all 3 sync to B
  for (const tag of urls) {
    const found = await browserB.testBridge.waitForTabUrl(tag, 20000);
    await Assert.isTrue(!!found, `B should have ${tag} before rapid move`);
  }

  // Create second window
  const otherWindow = await browserA.testBridge.createWindow(generateTestUrl('rapid-other'));
  await sleep(500);

  // Move all 3 out rapidly (no sleep between calls)
  console.log('  Moving all 3 tabs out rapidly...');
  for (const tab of tabs) {
    await browserA.testBridge.moveTabToWindow(tab.id, otherWindow.id);
  }

  // Wait for sync to settle
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await sleep(1000);

  // Verify B has none of the 3
  let tabsB = await browserB.testBridge.getTabs();
  for (const tag of urls) {
    const hasIt = tabsB.find(t => t.url && t.url.includes(tag));
    console.log(`  B has ${tag} after move out: ${!!hasIt}`);
    await Assert.isTrue(!hasIt, `B should NOT have ${tag} after rapid move out`);
  }

  // Move all 3 back rapidly
  console.log('  Moving all 3 tabs back rapidly...');
  for (const tab of tabs) {
    await browserA.testBridge.moveTabToWindow(tab.id, syncWindowId);
  }

  // Wait for sync to settle
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Verify B has all 3 again
  for (const tag of urls) {
    const found = await browserB.testBridge.waitForTabUrl(tag, 15000);
    console.log(`  B has ${tag} after move back: ${!!found}`);
    await Assert.isTrue(!!found, `B should have ${tag} after rapid move back`);
  }

  // Clean up
  try {
    await browserA.testBridge.closeWindow(otherWindow.id);
  } catch (e) {
    // may fail
  }
  await sleep(500);

  results.pass('Rapid Movement of Multiple Tabs');
}

async function main() {
  console.log('='.repeat(60));
  console.log('TAB MOVEMENT TESTS');
  console.log('='.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    // Wait for connection + initial sync
    console.log();
    console.log('Waiting for connection...');
    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'Browser A should connect');
    await Assert.isTrue(connectedB, 'Browser B should connect');

    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('Connected and synced');

    const tests = [
      testTabMovedOutRemovedFromPeer,
      testTabMovedInAppearsOnPeer,
      testTabMovedOutAndBack,
      testRapidMovementOfMultipleTabs,
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

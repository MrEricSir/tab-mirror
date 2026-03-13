#!/usr/bin/env node
/**
 * Sync Pause/Resume Tests
 *
 * Tests behavior when sync is paused (enabled toggle off) and resumed:
 * - Tabs created while paused should not sync
 * - Tabs should sync immediately when unpaused (without needing navigation)
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testConnectionSetup(browserA, browserB) {
  console.log();
  console.log('Test: Connection Setup');

  const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
  const connectedB = await browserB.testBridge.waitForConnections(1, 30000);

  await Assert.isTrue(connectedA, 'Browser A should connect to Browser B');
  await Assert.isTrue(connectedB, 'Browser B should connect to Browser A');

  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  results.pass('Connection Setup');
}

async function testPausedTabsDoNotSync(browserA, browserB) {
  console.log();
  console.log('Test: Tabs created while paused do not sync');

  const initialTabsB = await browserB.testBridge.getTabs();
  const initialCountB = initialTabsB.length;
  console.log(`  Browser B initial tab count: ${initialCountB}`);

  // Pause sync on Browser A
  console.log('  Pausing sync on Browser A...');
  await browserA.testBridge.setSyncPaused(true);
  await sleep(500);

  // Verify it's paused
  const pauseState = await browserA.testBridge.getSyncPaused();
  console.log(`  Sync paused: ${pauseState.paused}`);
  await Assert.isTrue(pauseState.paused, 'Sync should be paused');

  // Create a tab while paused
  const pausedUrl = generateTestUrl('paused-tab');
  console.log(`  Creating tab in Browser A while paused...`);
  const pausedTab = await browserA.testBridge.createTab(pausedUrl);
  await browserA.testBridge.waitForTabLoad(pausedTab.id);

  // Wait a bit and verify it did NOT sync to B
  await sleep(3000);

  const tabsB = await browserB.testBridge.getTabs();
  const pausedTabInB = tabsB.find(t => t.url && t.url.includes('paused-tab'));
  console.log(`  Browser B tab count after paused create: ${tabsB.length}`);
  console.log(`  Paused tab found in B: ${!!pausedTabInB}`);

  await Assert.isTrue(!pausedTabInB, 'Tab created while paused should NOT appear in Browser B');

  results.pass('Tabs created while paused do not sync');
}

async function testUnpauseTriggersSyncImmediately(browserA, browserB) {
  console.log();
  console.log('Test: Unpausing sync triggers immediate broadcast');

  // At this point, sync is still paused from previous test and there's
  // a tab in A that hasn't synced to B yet.
  const pauseState = await browserA.testBridge.getSyncPaused();
  await Assert.isTrue(pauseState.paused, 'Sync should still be paused from previous test');

  const tabsA = await browserA.testBridge.getTabs();
  const pausedTab = tabsA.find(t => t.url && t.url.includes('paused-tab'));
  await Assert.isTrue(!!pausedTab, 'Paused tab should exist in Browser A');

  // Unpause sync - this should trigger an immediate broadcast
  console.log('  Unpausing sync on Browser A...');
  await browserA.testBridge.setSyncPaused(false);

  // Wait for the tab to sync to B (without any navigation!)
  console.log('  Waiting for paused tab to appear in Browser B...');
  const synced = await browserB.testBridge.waitForTabUrl('paused-tab', 15000);

  console.log(`  Paused tab synced to B: ${!!synced}`);
  await Assert.isTrue(!!synced, 'Tab created while paused should sync to Browser B after unpausing');

  results.pass('Unpausing sync triggers immediate broadcast');
}

async function main() {
  console.log('='.repeat(60));
  console.log('SYNC PAUSE/RESUME TESTS');
  console.log('='.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    const tests = [
      testConnectionSetup,
      testPausedTabsDoNotSync,
      testUnpauseTriggersSyncImmediately,
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

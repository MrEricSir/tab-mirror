#!/usr/bin/env node
/**
 * Concurrent Sync Tests
 *
 * Checks that simultaneous sync operations don't lose data:
 * - Sync queue -- incoming syncs are queued when already processing
 * - 3-peer mesh -- tabs from two peers reach a third without loss
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testSyncQueueMechanics(browser) {
  console.log();
  console.log('Test: Sync Queue Mechanics');

  const result = await browser.testBridge.testSyncQueue();
  console.log(`  Result: ${JSON.stringify(result)}`);

  await Assert.isTrue(result.queuedTwo, 'Should queue two syncs from different peers');
  await Assert.isTrue(result.replacedOlder, 'Should still have 2 items after replacing peer-1 state');
  await Assert.isTrue(result.newestKept, 'Should keep the newest state for peer-1');

  results.pass('Sync Queue Mechanics');
}

async function testConcurrentSyncsFromTwoPeers(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Concurrent Syncs From Two Peers');

  // Wait for mesh to form
  console.log('  Waiting for mesh network...');
  const connA = await browserA.testBridge.waitForConnections(2, 45000);
  const connB = await browserB.testBridge.waitForConnections(2, 45000);
  const connC = await browserC.testBridge.waitForConnections(2, 45000);

  await Assert.isTrue(connA, 'A should connect to B and C');
  await Assert.isTrue(connB, 'B should connect to A and C');
  await Assert.isTrue(connC, 'C should connect to A and B');

  // Let initial syncs finish
  const allBrowsers = [
    { name: 'A', bridge: browserA.testBridge },
    { name: 'B', bridge: browserB.testBridge },
    { name: 'C', bridge: browserC.testBridge }
  ];

  const syncDeadline = Date.now() + 45000;
  for (const { name, bridge } of allBrowsers) {
    while (Date.now() < syncDeadline) {
      const peers = await bridge.getSyncedPeers();
      if (peers.length >= 2) {
        break;
      }
      console.log(`  ${name}: ${peers.length}/2 synced peers, waiting...`);
      await sleep(2000);
    }
  }

  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // Mute C so it doesn't broadcast back and complicate things
  await browserC.testBridge.muteOutgoing(true);

  const tabsBefore = (await browserC.testBridge.getTabs()).length;
  console.log(`  C tabs before: ${tabsBefore}`);

  // Create tabs on A and B near-simultaneously
  const urlA = generateTestUrl('concurrent-from-A');
  const urlB = generateTestUrl('concurrent-from-B');
  console.log(`  Creating tab on A: ${urlA}`);
  console.log(`  Creating tab on B: ${urlB}`);

  await browserA.testBridge.createTab(urlA);
  await browserB.testBridge.createTab(urlB);

  // Wait for both tabs to appear on C
  console.log('  Waiting for both tabs to arrive on C...');
  const tabFromA = await browserC.testBridge.waitForTabUrl('concurrent-from-A', 30000);
  const tabFromB = await browserC.testBridge.waitForTabUrl('concurrent-from-B', 30000);

  await Assert.isTrue(!!tabFromA, 'C should receive tab from A');
  await Assert.isTrue(!!tabFromB, 'C should receive tab from B');

  const tabsAfter = await browserC.testBridge.getTabs();
  console.log(`  C tabs after: ${tabsAfter.length}`);

  // Unmute C
  await browserC.testBridge.muteOutgoing(false);

  results.pass('Concurrent Syncs From Two Peers');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('CONCURRENT SYNC TESTS');
  console.log('═'.repeat(60));

  let browserA, browserB, browserC;

  try {
    // Deterministic queue test (single browser)
    console.log();
    console.log('Launching browser for queue test...');
    browserA = await launchBrowser();
    console.log('✅ Browser launched');

    await testSyncQueueMechanics(browserA);

    await cleanupBrowser(browserA);
    browserA = null;

    // 3-browser concurrent sync test
    console.log();
    console.log('Launching 3 browsers for concurrent test...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    browserC = await launchBrowser();
    console.log('✅ All browsers launched');

    await testConcurrentSyncsFromTwoPeers(browserA, browserB, browserC);

  } catch (error) {
    results.error('Test Suite', error);
  } finally {
    console.log();
    console.log('Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
    await cleanupBrowser(browserC);
  }

  results.summary();
  process.exit(results.exitCode());
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

main();

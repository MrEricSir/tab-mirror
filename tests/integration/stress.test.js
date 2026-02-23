#!/usr/bin/env node
/**
 * Stress Tests
 *
 * Tests system behavior under load:
 * - Many tabs (20+)
 * - Rapid changes
 * - Large-scale sync
 * - Performance checks
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testManyTabsSync(browserA, browserB) {
  console.log();
  console.log('Test: Many Tabs Synchronization (20 tabs)');

  const initialCount = (await browserA.testBridge.getTabs()).length;
  console.log(`  Initial tab count: ${initialCount}`);

  // Create 20 tabs with unique URLs so they don't collide
  console.log('  Creating 20 tabs in Browser A...');

  for (let i = 0; i < 20; i++) {
    await browserA.testBridge.createTab(generateTestUrl(`stress-test-${i}`));
    await sleep(300);
    if (i % 5 === 0) {
      console.log(`    Created ${i + 1} tabs...`);
    }
  }

  const newCountA = (await browserA.testBridge.getTabs()).length;
  console.log(`  Browser A now has ${newCountA} tabs`);

  // Wait for sync
  console.log('  Waiting for sync to Browser B (may take a while)...');
  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);

  const finalCountB = (await browserB.testBridge.getTabs()).length;
  console.log(`  Browser B now has ${finalCountB} tabs`);

  // Allow for minor variance from dedup or timing
  const diff = Math.abs(newCountA - finalCountB);
  const percentSynced = Math.round((1 - diff / newCountA) * 100);
  console.log(`  Sync success rate: ${percentSynced}%`);

  await Assert.lessThan(diff, 3, `Most tabs should sync (off by ${diff}, tolerance: 2)`);

  results.pass('Many Tabs Synchronization');
}

async function testRapidTabChanges(browserA, browserB) {
  console.log();
  console.log('Test: Rapid Tab Changes');

  const initialCount = (await browserA.testBridge.getTabs()).length;
  console.log(`  Initial tab count: ${initialCount}`);

  // Create and close tabs fast
  console.log('  Rapidly creating and closing tabs...');

  for (let i = 0; i < 5; i++) {
    await browserA.testBridge.createTab(generateTestUrl(`rapid-${i}`));
    await sleep(100); // Very short delay
  }

  await sleep(500);

  // Close 3 non-testbridge-init tabs (last 3)
  const allTabs = await browserA.testBridge.getTabs();
  const closeable = allTabs.filter(t => t.url && !t.url.includes('testbridge-init'));
  const toClose = closeable.slice(-3); // close last 3
  for (const tab of toClose) {
    await browserA.testBridge.closeTab(tab.id);
    await sleep(100);
  }
  console.log(`  Closed ${toClose.length} tabs`);

  await sleep(1000);

  const finalCountA = (await browserA.testBridge.getTabs()).length;
  console.log(`  Browser A final count: ${finalCountA}`);

  // Let B catch up
  console.log('  Waiting for Browser B to stabilize...');
  await browserB.testBridge.waitForSyncComplete(10000);

  const finalCountB = (await browserB.testBridge.getTabs()).length;
  console.log(`  Browser B final count: ${finalCountB}`);

  // Should eventually converge (some timing wiggle is ok)
  const diff = Math.abs(finalCountA - finalCountB);
  console.log(`  Difference: ${diff} tabs`);
  await Assert.lessThan(diff, 4, `Browsers should converge (diff: ${diff}, tolerance: 3)`);

  // Check event buffer has both created and removed events
  const events = await browserA.testBridge.getTabEvents(true);
  const created = events.filter(e => e.type === 'created');
  const removed = events.filter(e => e.type === 'removed');
  console.log(`  Tab events - created: ${created.length}, removed: ${removed.length}`);
  await Assert.greaterThan(created.length, 0, 'Should have created events');
  await Assert.greaterThan(removed.length, 0, 'Should have removed events');

  results.pass('Rapid Tab Changes');
}

async function testStateConsistency(browserA, browserB) {
  console.log();
  console.log('Test: State Consistency Check');

  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  console.log(`  Browser A - Device: ${stateA.myDeviceId}, Peers: ${stateA.syncedPeers.length}`);
  console.log(`  Browser B - Device: ${stateB.myDeviceId}, Peers: ${stateB.syncedPeers.length}`);

  // Both should see each other
  await Assert.includes(stateA.syncedPeers, stateB.myDeviceId, 'A should have B as peer');
  await Assert.includes(stateB.syncedPeers, stateA.myDeviceId, 'B should have A as peer');

  // Sync counters should be non-zero
  console.log(`  Sync counters - A: ${stateA.syncCounter}, B: ${stateB.syncCounter}`);
  await Assert.greaterThan(stateA.syncCounter, 0, 'Browser A should have synced');
  await Assert.greaterThan(stateB.syncCounter, 0, 'Browser B should have synced');

  results.pass('State Consistency Check');
}

async function testLogCapture(browserA) {
  console.log();
  console.log('Test: Log Capture');

  const logs = await browserA.testBridge.getLogs();

  console.log(`  Captured ${logs.length} log entries`);

  await Assert.greaterThan(logs.length, 0, 'Should have captured logs');

  // Check log shape
  const firstLog = logs[0];
  await Assert.isTrue('timestamp' in firstLog, 'Log should have timestamp');
  await Assert.isTrue('level' in firstLog, 'Log should have level');
  await Assert.isTrue('message' in firstLog, 'Log should have message');

  console.log(`  Sample log: [${firstLog.level}] ${firstLog.message.substring(0, 50)}...`);

  results.pass('Log Capture');
}

async function testManualSync(browserA, browserB) {
  console.log();
  console.log('Test: Manual Sync Trigger');

  // Add a tab
  console.log('  Creating tab in Browser A...');
  await browserA.testBridge.createTab(generateTestUrl('manual-sync-test'));
  await sleep(500);

  // Fire manual sync
  console.log('  Triggering manual sync...');
  await browserA.testBridge.triggerSync();
  await browserA.testBridge.waitForSyncComplete(10000);

  // Make sure sync happened
  const stateA = await browserA.testBridge.getState();
  console.log(`  Sync counter after manual trigger: ${stateA.syncCounter}`);

  await Assert.greaterThan(stateA.syncCounter, 0, 'Manual sync should increment counter');

  results.pass('Manual Sync Trigger');
}

async function testBroadcastSerialization(browserA, browserB) {
  console.log();
  console.log('Test: Broadcast Serialization');

  // Clear stats on both browsers
  await browserA.testBridge.resetBroadcastStats();
  await browserB.testBridge.resetBroadcastStats();

  // Fire off 10 tabs with no sleep between them
  console.log('  Creating 10 tabs rapidly (no delay)...');
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(browserA.testBridge.createTab(generateTestUrl(`burst-${i}`)));
  }
  await Promise.all(promises);

  // Let broadcasts settle
  console.log('  Waiting for broadcasts to settle...');
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(15000);
  await sleep(2000);

  // Look at broadcast stats
  const stats = await browserA.testBridge.getBroadcastStats();
  console.log(`  Broadcast stats: attempted=${stats.attempted}, completed=${stats.completed}, deferred=${stats.deferred}`);

  // 10 rapid tab creates should get collapsed by debouncing into way fewer broadcasts.
  // Without debounce, each tab create fires a separate broadcast (10+).
  // With debounce + serialization, we expect a small number (typically 1-3).
  await Assert.isTrue(stats.completed <= 5,
    `Broadcasts should be debounced: ${stats.completed} completed from 10 rapid tab ops (expected <= 5)`);

  // Check final state is consistent
  await browserB.testBridge.waitForSyncComplete(15000);
  await sleep(2000);
  const tabsA = await browserA.testBridge.getTabs();
  const tabsB = await browserB.testBridge.getTabs();
  const burstTabsA = tabsA.filter(t => t.url && t.url.includes('burst-'));
  const burstTabsB = tabsB.filter(t => t.url && t.url.includes('burst-'));
  console.log(`  Burst tabs - A: ${burstTabsA.length}, B: ${burstTabsB.length}`);

  await Assert.equal(burstTabsA.length, 10, 'Browser A should have all 10 burst tabs');
  await Assert.equal(burstTabsB.length, 10, 'Browser B should have all 10 burst tabs');

  results.pass('Broadcast Serialization');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('STRESS TESTS');
  console.log('═'.repeat(60));
  console.log('⚠️  These tests may take several minutes to complete');

  let browserA, browserB;

  try {
    // Fire up browsers
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    await sleep(500); // Make sure timestamps differ for unique IDs
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');

    // Wait for them to connect
    console.log();
    console.log('Waiting for connection...');
    await browserA.testBridge.waitForConnections(1, 15000);
    console.log('✅ Connected');

    // Run tests -- each wrapped so one failure doesn't stop the suite
    const tests = [
      testManyTabsSync,
      testRapidTabChanges,
      testStateConsistency,
      testLogCapture,
      testManualSync,
      testBroadcastSerialization,
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
    // Clean up
    console.log();
    console.log('Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }

  // Show results
  results.summary();
  process.exit(results.exitCode());
}

// Catch unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

main();

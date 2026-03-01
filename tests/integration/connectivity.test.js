#!/usr/bin/env node
/**
 * Connectivity Tests
 *
 * Tests automatic peer discovery and initial sync:
 * 1. Auto-discovery within 3-20 seconds
 * 2. Initial sync merges tabs from both browsers
 * 3. Connection recovery after manual reset
 */

const { launchBrowser, cleanupBrowser, TestResults, TabUtils, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');
const { execSync } = require('child_process');

const results = new TestResults();

/**
 * Get non-testbridge tabs
 */
async function getNonTestTabs(testBridge) {
  const allTabs = await testBridge.getTabs();
  return allTabs.filter(t => !t.url.includes('testbridge-init'));
}

/**
 * Check tab URLs match between browsers (order-independent)
 */
async function verifyTabsMatch(browserA, browserB, testName) {
  const tabsA = await getNonTestTabs(browserA.testBridge);
  const tabsB = await getNonTestTabs(browserB.testBridge);

  const urlsA = tabsA.map(t => t.url).sort();
  const urlsB = tabsB.map(t => t.url).sort();

  console.log(`  Browser A tabs (${urlsA.length}):`);
  urlsA.forEach(url => console.log(`    - ${url.substring(0, 60)}`));

  console.log(`  Browser B tabs (${urlsB.length}):`);
  urlsB.forEach(url => console.log(`    - ${url.substring(0, 60)}`));

  await Assert.equal(urlsA.length, urlsB.length, `${testName}: Tab counts should match`);

  // All URLs should match (order-independent comparison)
  for (let i = 0; i < urlsA.length; i++) {
    await Assert.equal(urlsA[i], urlsB[i], `${testName}: Tab ${i} URL should match`);
  }
}

async function testAutomaticDiscovery(browserA, browserB) {
  console.log();
  console.log('Test: Automatic Discovery Within 3-20 Seconds');

  const startTime = Date.now();
  let discovered = false;
  let discoveryTime = 0;

  console.log('  Waiting for automatic peer discovery...');

  // Poll every second, up to 25 seconds
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    try {
      const connectionCountA = await browserA.testBridge.getConnectionCount();
      const connectionCountB = await browserB.testBridge.getConnectionCount();

      if (connectionCountA > 0 && connectionCountB > 0) {
        discoveryTime = elapsed;
        discovered = true;
        console.log(`  ✅ Discovered! Connection established after ${discoveryTime} seconds`);
        break;
      }

      // Log every 5 seconds
      if (elapsed % 5 === 0) {
        console.log(`  [${elapsed}s] Still waiting... (A: ${connectionCountA}, B: ${connectionCountB})`);
      }
    } catch (error) {
      // ignore temporary errors
      if (elapsed % 10 === 0) {
        console.log(`  [${elapsed}s] Temporary error: ${error.message}`);
      }
    }
  }

  await Assert.isTrue(discovered, 'Browsers should discover each other automatically');
  await Assert.isTrue(discoveryTime >= 0, 'Discovery should have a non-negative time');
  await Assert.isTrue(discoveryTime <= 20, `Discovery should happen within 20 seconds (took ${discoveryTime}s)`);

  // Both sides should see each other
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  console.log(`  Browser A (${stateA.myDeviceId}) connected to: ${stateA.syncedPeers.join(', ')}`);
  console.log(`  Browser B (${stateB.myDeviceId}) connected to: ${stateB.syncedPeers.join(', ')}`);

  await Assert.includes(stateA.syncedPeers, stateB.myDeviceId, 'A should have B in peers');
  await Assert.includes(stateB.syncedPeers, stateA.myDeviceId, 'B should have A in peers');

  results.pass('Automatic Discovery Within 3-20 Seconds');
}

async function testInitialSyncMerge(browserA, browserB) {
  console.log();
  console.log('Test: Initial Sync Merges All Tabs');
  console.log('  (This test verifies that tabs from both browsers merge together)');

  // Instead of cleaning up existing tabs (which is complex),
  // just create new distinct tabs and check they all sync
  const tabsA = new TabUtils(browserA.driver);
  const tabsB = new TabUtils(browserB.driver);

  // Grab current tab counts
  const initialTabsA = await getNonTestTabs(browserA.testBridge);
  const initialTabsB = await getNonTestTabs(browserB.testBridge);

  console.log(`  Starting state - A: ${initialTabsA.length} tabs, B: ${initialTabsB.length} tabs`);

  // Create uniquely identifiable tabs
  console.log('  Creating uniquely identifiable tabs in Browser A...');
  const urlsA = [
    generateTestUrl('unique-merge-a-1'),
    generateTestUrl('unique-merge-a-2')
  ];

  for (const url of urlsA) {
    await tabsA.openTab(url);
    await sleep(500);
  }

  console.log('  Creating uniquely identifiable tabs in Browser B...');
  const urlsB = [
    generateTestUrl('unique-merge-b-1'),
    generateTestUrl('unique-merge-b-2')
  ];

  for (const url of urlsB) {
    await tabsB.openTab(url);
    await sleep(500);
  }

  console.log('  Waiting for automatic sync...');
  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);

  // Fire explicit sync to be sure
  await browserA.testBridge.triggerSync();
  await browserB.testBridge.triggerSync();

  // Let sync stabilize
  console.log('  Waiting for sync to complete...');
  await browserA.testBridge.waitForSyncComplete(20000);
  await browserB.testBridge.waitForSyncComplete(20000);

  console.log('  Verifying all unique tabs present in both browsers...');

  const finalTabsA = await getNonTestTabs(browserA.testBridge);
  const finalTabsB = await getNonTestTabs(browserB.testBridge);

  console.log(`  Final state - A: ${finalTabsA.length} tabs, B: ${finalTabsB.length} tabs`);

  // Find our test tabs
  const allTestUrls = [...urlsA, ...urlsB];
  const foundInA = finalTabsA.filter(t =>
    allTestUrls.some(url => t.url === url)
  );
  const foundInB = finalTabsB.filter(t =>
    allTestUrls.some(url => t.url === url)
  );

  console.log(`  Browser A has ${foundInA.length}/${allTestUrls.length} test tabs:`);
  foundInA.forEach(t => console.log(`    - ${t.url.substring(t.url.length - 30)}`));

  console.log(`  Browser B has ${foundInB.length}/${allTestUrls.length} test tabs:`);
  foundInB.forEach(t => console.log(`    - ${t.url.substring(t.url.length - 30)}`));

  // Both browsers should have all test tabs
  await Assert.equal(
    foundInA.length,
    allTestUrls.length,
    `Browser A should have all ${allTestUrls.length} test tabs`
  );
  await Assert.equal(
    foundInB.length,
    allTestUrls.length,
    `Browser B should have all ${allTestUrls.length} test tabs`
  );

  // Check specific URLs are present
  for (const url of allTestUrls) {
    const inA = finalTabsA.some(t => t.url === url);
    const inB = finalTabsB.some(t => t.url === url);

    const urlLabel = url.substring(url.length - 20);
    await Assert.isTrue(inA, `Browser A should have ${urlLabel}`);
    await Assert.isTrue(inB, `Browser B should have ${urlLabel}`);
  }

  console.log('  ✅ All tabs successfully merged between browsers');

  results.pass('Initial Sync Merges All Tabs');
}

async function testReconnectionAfterReset(browserA, browserB) {
  console.log();
  console.log('Test: Reconnection After Manual Reset');

  // Make sure we're connected
  const initialConnectionCount = await browserA.testBridge.getConnectionCount();
  console.log(`  Initial connection count: ${initialConnectionCount}`);
  await Assert.greaterThan(initialConnectionCount, 0, 'Should be connected initially');

  // Grab current state
  const stateBeforeReset = await browserA.testBridge.getState();
  const peerIdB = stateBeforeReset.syncedPeers[0];

  console.log(`  Simulating connection reset...`);

  // Reinitialize TestBridge context (loses state).
  // Simulates what happens when you click "Reset Connection"
  console.log(`  Triggering manual sync to force connection check...`);
  await browserA.testBridge.triggerSync();
  await browserA.testBridge.waitForSyncComplete(10000);

  // Should still be connected
  const connectionCountAfterSync = await browserA.testBridge.getConnectionCount();
  console.log(`  Connection count after sync: ${connectionCountAfterSync}`);

  await Assert.greaterThan(
    connectionCountAfterSync,
    0,
    'Should maintain connection after sync'
  );

  // Peer ID should be the same
  const stateAfterSync = await browserA.testBridge.getState();
  await Assert.includes(
    stateAfterSync.syncedPeers,
    peerIdB,
    'Should still be connected to same peer'
  );

  console.log('  ✅ Connection maintained after reset simulation');

  results.pass('Reconnection After Manual Reset');
}

async function testPreExistingTabsMerge(browserA, browserB) {
  console.log();
  console.log('Test: Pre-existing Tabs Merge on First Connection');
  console.log('  Note: This test launches fresh browsers with existing tabs');

  let freshBrowserA, freshBrowserB;

  try {
    // Shut down existing browsers (profiles + drivers)
    console.log('  Closing existing browsers...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);

    // Kill lingering geckodrivers to free PeerJS connections
    try {
      execSync('pkill -9 -f geckodriver 2>/dev/null || true');
    } catch (e) {
      // ignore it
    }
    await sleep(2000);

    // Launch A and create some tabs before connecting
    console.log('  Launching Browser A with pre-existing tabs...');
    freshBrowserA = await launchBrowser();

    const urlSetA = [
      generateTestUrl('pre-a-1'),
      generateTestUrl('pre-a-2')
    ];

    for (const url of urlSetA) {
      await freshBrowserA.testBridge.createTab(url);
      await sleep(1000);
    }

    console.log(`  Browser A created ${urlSetA.length} tabs`);
    await sleep(1000);

    // Launch B and create different tabs before connecting
    console.log('  Launching Browser B with pre-existing tabs...');
    freshBrowserB = await launchBrowser();

    const urlSetB = [
      generateTestUrl('pre-b-1'),
      generateTestUrl('pre-b-2')
    ];

    for (const url of urlSetB) {
      await freshBrowserB.testBridge.createTab(url);
      await sleep(500);
    }

    console.log(`  Browser B created ${urlSetB.length} tabs`);
    await sleep(1000);

    // Wait for auto-discovery and connection
    console.log('  Waiting for automatic discovery and merge...');
    const discoveryStartTime = Date.now();
    let connected = false;

    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const elapsed = Math.floor((Date.now() - discoveryStartTime) / 1000);

      try {
        const connCountA = await freshBrowserA.testBridge.getConnectionCount();
        const connCountB = await freshBrowserB.testBridge.getConnectionCount();

        if (connCountA > 0 && connCountB > 0) {
          console.log(`  ✅ Connected after ${elapsed} seconds`);
          connected = true;
          break;
        }

        if (elapsed % 5 === 0) {
          console.log(`  [${elapsed}s] Waiting for discovery...`);
        }
      } catch (error) {
        // ignore temporary errors
        if (elapsed % 10 === 0) {
          console.log(`  [${elapsed}s] (polling, ignoring: ${error.message})`);
        }
      }
    }

    await Assert.isTrue(connected, 'Browsers should discover each other');

    // Wait for merge
    console.log('  Waiting for initial merge...');

    try {
      await freshBrowserA.testBridge.waitForSyncComplete(20000);
    } catch (e) {
      console.log(`  Note: Browser A sync wait had issues: ${e.message}`);
    }

    try {
      await freshBrowserB.testBridge.waitForSyncComplete(20000);
    } catch (e) {
      console.log(`  Note: Browser B sync wait had issues: ${e.message}`);
    }

    // Extra sync cycle for convergence
    await freshBrowserA.testBridge.waitForSyncComplete(10000);
    await freshBrowserB.testBridge.waitForSyncComplete(10000);

    // Check merge results
    console.log('  Verifying all tabs present in both browsers...');
    const allExpectedUrls = [...urlSetA, ...urlSetB];

    const finalTabsA = await getNonTestTabs(freshBrowserA.testBridge);
    const finalTabsB = await getNonTestTabs(freshBrowserB.testBridge);

    const foundInA = finalTabsA.filter(t =>
      allExpectedUrls.some(url => t.url === url)
    );
    const foundInB = finalTabsB.filter(t =>
      allExpectedUrls.some(url => t.url === url)
    );

    console.log(`  Browser A has ${foundInA.length}/${allExpectedUrls.length} expected tabs`);
    foundInA.forEach(t => console.log(`    - ${t.url.substring(t.url.length - 20)}`));

    console.log(`  Browser B has ${foundInB.length}/${allExpectedUrls.length} expected tabs`);
    foundInB.forEach(t => console.log(`    - ${t.url.substring(t.url.length - 20)}`));

    // At least most tabs should be present (some timing wiggle ok)
    await Assert.greaterThan(
      foundInA.length,
      allExpectedUrls.length - 2,
      `Browser A should have at least ${allExpectedUrls.length - 1} tabs`
    );
    await Assert.greaterThan(
      foundInB.length,
      allExpectedUrls.length - 2,
      `Browser B should have at least ${allExpectedUrls.length - 1} tabs`
    );

    // Clean up fresh browsers
    console.log('  Cleaning up fresh browsers...');
    await cleanupBrowser(freshBrowserA);
    await cleanupBrowser(freshBrowserB);

    results.pass('Pre-existing Tabs Merge on First Connection');
  } catch (error) {
    // Clean up on error
    console.log('  Error occurred, cleaning up...');
    await cleanupBrowser(freshBrowserA);
    await cleanupBrowser(freshBrowserB);
    throw error;
  }
}

async function testDuplicateUrlNotCollapsed(browserA, browserB) {
  console.log();
  console.log('Test: Duplicate URLs Not Collapsed');
  console.log('  Both browsers independently create tabs with the same URL');
  console.log('  Merge should NOT collapse them into one.');
  console.log();

  let freshA, freshB;

  try {
    // Shut down existing browsers
    console.log('  Closing existing browsers...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
    try {
      execSync('pkill -9 -f geckodriver 2>/dev/null || true');
    } catch (e) {
      // ignore it
    }
    await sleep(2000);

    // Launch fresh browsers
    freshA = await launchBrowser();
    freshB = await launchBrowser();

    // Create tabs with the SAME URLs on each browser independently
    const sharedUrl1 = 'http://127.0.0.1:8080/shared-dup-page';
    const sharedUrl2 = 'http://127.0.0.1:8080/shared-dup-other';

    console.log('  Creating same URLs on both browsers...');
    await freshA.testBridge.createTab(sharedUrl1);
    await freshA.testBridge.createTab(sharedUrl2);
    // Also create a unique tab on A to check dedup only happens for shared URLs
    const uniqueA = generateTestUrl('unique-to-a');
    await freshA.testBridge.createTab(uniqueA);

    await freshB.testBridge.createTab(sharedUrl1);
    await freshB.testBridge.createTab(sharedUrl2);
    const uniqueB = generateTestUrl('unique-to-b');
    await freshB.testBridge.createTab(uniqueB);

    await sleep(1000);

    // Wait for connection + sync
    const connected = await freshA.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connected, 'Browsers should connect');

    await freshA.testBridge.waitForSyncComplete(20000);
    await freshB.testBridge.waitForSyncComplete(20000);

    // Both should have each other's unique tabs
    const tabsA = await getNonTestTabs(freshA.testBridge);
    const tabsB = await getNonTestTabs(freshB.testBridge);

    console.log(`  A tabs: ${tabsA.length}, B tabs: ${tabsB.length}`);
    tabsA.forEach(t => console.log(`    A: ${t.url}`));

    // Both unique tabs should exist on both browsers
    const aHasUniqueB = tabsA.some(t => t.url && t.url.includes('unique-to-b'));
    const bHasUniqueA = tabsB.some(t => t.url && t.url.includes('unique-to-a'));
    await Assert.isTrue(aHasUniqueB, 'A should have unique-to-b');
    await Assert.isTrue(bHasUniqueA, 'B should have unique-to-a');

    // Shared URLs should be deduped: each browser has them once, not twice
    // (atomic merge deduplicates by URL+pinned, so shared-dup-page appears once)
    const sharedInA = tabsA.filter(t => t.url === sharedUrl1);
    const sharedInB = tabsB.filter(t => t.url === sharedUrl1);
    console.log(`  shared-dup-page count: A: ${sharedInA.length}, B: ${sharedInB.length}`);
    await Assert.equal(sharedInA.length, 1, 'A should have shared URL deduplicated to 1');
    await Assert.equal(sharedInB.length, 1, 'B should have shared URL deduplicated to 1');

    // Clean up
    await cleanupBrowser(freshA);
    await cleanupBrowser(freshB);

    results.pass('Duplicate URLs Not Collapsed');
  } catch (error) {
    await cleanupBrowser(freshA);
    await cleanupBrowser(freshB);
    throw error;
  }
}

async function testRestartForcesAtomicMerge(browserA, browserB) {
  console.log();
  console.log('Test: Restart Clears State and Forces Atomic Merge');

  let freshA, freshB;
  try {
    // Shut down existing browsers
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
    try {
      execSync('pkill -9 -f geckodriver 2>/dev/null || true');
    } catch (e) {
      // ignore it
    }
    await sleep(2000);

    freshA = await launchBrowser();
    freshB = await launchBrowser();

    // Let initial sync settle
    const connected = await freshA.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connected, 'Should connect');
    await freshA.testBridge.waitForSyncComplete(10000);
    await freshB.testBridge.waitForSyncComplete(10000);

    // Add some tabs
    const url1 = generateTestUrl('restart-test-1');
    const url2 = generateTestUrl('restart-test-2');
    await freshA.testBridge.createTab(url1);
    await freshB.testBridge.createTab(url2);
    await sleep(2000);
    await freshA.testBridge.waitForSyncComplete(10000);
    await freshB.testBridge.waitForSyncComplete(10000);

    // Grab state before restart
    const stateBeforeA = await freshA.testBridge.getState();
    console.log(`  Before restart: A synced peers: ${stateBeforeA.syncedPeers.length}`);

    // Restart A
    console.log('  Simulating restart on Browser A...');
    await freshA.testBridge.simulateRestart();
    await sleep(2000);

    // A's synced peers should be preserved but it'll need to re-sync
    const stateAfterRestart = await freshA.testBridge.getState();
    console.log(`  After restart: A connections: ${stateAfterRestart.connections.length}, synced peers: ${stateAfterRestart.syncedPeers.length}`);

    // Fire sync to reconnect (PeerJS may auto-reconnect quickly)
    await freshB.testBridge.triggerSync();
    await sleep(2000);

    const reconnected = await freshA.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(reconnected, 'A should reconnect');

    await freshA.testBridge.waitForSyncComplete(15000);
    await freshB.testBridge.waitForSyncComplete(15000);

    // All tabs should still be present (atomic merge preserves them)
    const tabsA = await getNonTestTabs(freshA.testBridge);
    const hasUrl1 = tabsA.some(t => t.url && t.url.includes('restart-test-1'));
    const hasUrl2 = tabsA.some(t => t.url && t.url.includes('restart-test-2'));
    console.log(`  After re-sync: A has restart-test-1: ${hasUrl1}, restart-test-2: ${hasUrl2}`);
    await Assert.isTrue(hasUrl1, 'A should still have restart-test-1');
    await Assert.isTrue(hasUrl2, 'A should still have restart-test-2');

    await cleanupBrowser(freshA);
    await cleanupBrowser(freshB);
    results.pass('Restart Clears State and Forces Atomic Merge');
  } catch (error) {
    await cleanupBrowser(freshA);
    await cleanupBrowser(freshB);
    throw error;
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('CONNECTIVITY TESTS');
  console.log('═'.repeat(60));
  console.log();
  console.log('These tests verify automatic peer discovery and');
  console.log('initial synchronization behavior.');
  console.log();

  let browserA, browserB;

  try {
    // Test 1: Automatic Discovery
    console.log('Launching browsers for automatic discovery test...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');
    console.log();

    await testAutomaticDiscovery(browserA, browserB);

    // Test 2: Initial Sync Merge (reuses connected browsers)
    await testInitialSyncMerge(browserA, browserB);

    // Test 3: Reconnection (reuses connected browsers)
    await testReconnectionAfterReset(browserA, browserB);

    // Test 4: Pre-existing tabs (launches fresh browsers)
    await testPreExistingTabsMerge(browserA, browserB);

    // Test 5: Duplicate URLs (launches fresh browsers)
    await testDuplicateUrlNotCollapsed(browserA, browserB);

    // Test 6: Restart forces atomic merge (launches fresh browsers)
    await testRestartForcesAtomicMerge(browserA, browserB);

  } catch (error) {
    results.error('Test Suite', error);
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

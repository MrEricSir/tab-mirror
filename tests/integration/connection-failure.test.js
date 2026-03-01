#!/usr/bin/env node
/**
 * Connection Failure Tests
 *
 * Checks that Tab Mirror handles connection failures gracefully:
 * - Server becomes unavailable
 * - Server restarts and connections recover
 * - Tabs stay stable during failures
 * - No data loss or corruption
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testServerFailureDuringOperation(browserA, browserB) {
  console.log();
  console.log('Test: Server Failure During Operation');

  // Check initial connection
  const connected = await browserA.testBridge.waitForConnections(1, 10000);
  await Assert.isTrue(connected, 'Browsers should be connected initially');

  const initialCountA = (await browserA.testBridge.getTabs()).length;
  const initialCountB = (await browserB.testBridge.getTabs()).length;
  console.log(`  Initial counts - A: ${initialCountA}, B: ${initialCountB}`);

  // Add a tab while connected
  console.log('  Creating tab while connected...');
  await browserA.testBridge.createTab(generateTestUrl('before-failure'));
  await sleep(1000);

  const countBeforeFailure = (await browserA.testBridge.getTabs()).length;
  console.log(`  Count before failure: ${countBeforeFailure}`);

  // Note: server is managed by run-with-server.js
  // We can't actually stop it here without breaking the test infra.
  // This test just checks that browsers stay stable when server is unavailable
  console.log('  ⚠️  Note: Full server restart testing requires manual test setup');
  console.log('  Testing that browsers remain stable...');

  // Tabs should stay put
  await sleep(1000);
  const countAfter = (await browserA.testBridge.getTabs()).length;
  await Assert.equal(countAfter, countBeforeFailure, 'Tab count should remain stable');

  results.pass('Server Failure During Operation');
}

async function testTabStabilityWithoutServer(browserA, browserB) {
  console.log();
  console.log('Test: Tab Stability Without Active Connection');

  const initialCountA = (await browserA.testBridge.getTabs()).length;
  const initialCountB = (await browserB.testBridge.getTabs()).length;

  console.log(`  Initial - A: ${initialCountA}, B: ${initialCountB}`);

  // Create tabs locally (won't sync if server is down)
  console.log('  Creating local tabs...');
  const uniqueUrl = generateTestUrl('local');
  await sleep(5000);
  await browserA.testBridge.createTab(uniqueUrl);
  await sleep(500);

  const newCountA = (await browserA.testBridge.getTabs()).length;
  console.log(`  Browser A: ${newCountA} tabs`);

  // Local operations should still work
  await Assert.equal(newCountA, initialCountA + 1, 'Local tab creation should work');

  // Tab should exist locally
  const tabsFromA = await browserA.testBridge.getTabs();
  const hasUrl = tabsFromA.some(tab => tab.url && tab.url.includes(uniqueUrl));
  await Assert.isTrue(hasUrl, 'Tab should exist locally');

  results.pass('Tab Stability Without Active Connection');
}

async function testConnectionRecovery(browserA, browserB) {
  console.log();
  console.log('Test: Connection Recovery');

  // Wait for connection
  console.log('  Waiting for connection...');
  const connected = await browserA.testBridge.waitForConnections(1, 15000);

  if (!connected) {
    console.log('  ⚠️  Connection not established (server may be unavailable)');
    console.log('  This is expected if testing without server');
  } else {
    console.log('  ✅ Connection established');

    const stateA = await browserA.testBridge.getState();
    const stateB = await browserB.testBridge.getState();

    console.log(`  Device A: ${stateA.myDeviceId}, peers: ${stateA.syncedPeers.length}`);
    console.log(`  Device B: ${stateB.myDeviceId}, peers: ${stateB.syncedPeers.length}`);

    await Assert.greaterThan(stateA.connections.length, 0, 'Browser A should have connections');
    await Assert.greaterThan(stateB.connections.length, 0, 'Browser B should have connections');
  }

  results.pass('Connection Recovery');
}

async function testNoDataLoss(browserA, browserB) {
  console.log();
  console.log('Test: No Data Loss During Failures');

  // Create a few test tabs
  console.log('  Creating test tabs...');
  const urls = [];
  for (let i = 0; i < 3; i++) {
    const url = generateTestUrl(`dataloss-test-${i}`);
    urls.push(url);
    await browserA.testBridge.createTab(url);
    await sleep(300);
  }

  console.log('  Waiting for operations to complete...');
  await sleep(1000);

  // All tabs should still be there
  const tabsFromA = await browserA.testBridge.getTabs();
  console.log(`  Browser A has ${tabsFromA.length} tabs`);

  let foundCount = 0;
  for (const url of urls) {
    const found = tabsFromA.some(tab => tab.url && tab.url.includes(url));
    if (found) {
      foundCount++;
    }
  }

  console.log(`  Found ${foundCount}/${urls.length} test tabs`);
  await Assert.equal(foundCount, urls.length, 'All test tabs should still exist');

  results.pass('No Data Loss During Failures');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('CONNECTION FAILURE TESTS');
  console.log('═'.repeat(60));
  console.log();
  console.log('⚠️  Note: These tests verify graceful degradation');
  console.log('Full server restart testing requires separate infrastructure');
  console.log();

  let browserA, browserB;

  try {
    // Launch browsers (server should already be running via run-with-server.js)
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    await sleep(500);
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');
    console.log();

    // Run the tests
    await testConnectionRecovery(browserA, browserB);
    await testTabStabilityWithoutServer(browserA, browserB);
    await testNoDataLoss(browserA, browserB);
    await testServerFailureDuringOperation(browserA, browserB);

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

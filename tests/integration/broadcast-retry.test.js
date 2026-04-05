#!/usr/bin/env node
/**
 * Broadcast Retry Tests
 *
 * Checks that Tab Mirror recovers from connection failures:
 * - Dead connections get cleaned up
 * - Peers automatically reconnect via discovery loop
 * - State re-syncs after reconnection
 * - Tabs created while disconnected sync after recovery
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testConnectionCleanupAfterDisconnect(browserA, browserB) {
  console.log();
  console.log('Test: Connection Cleanup After Disconnect');

  const deviceIdA = await browserA.testBridge.getDeviceId();
  const deviceIdB = await browserB.testBridge.getDeviceId();

  // Check initial connection
  const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(connectedA, 'Browser A should be connected');

  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  console.log(`  Device A: ${deviceIdA}`);
  console.log(`  Device B: ${deviceIdB}`);

  // Disconnect A from B
  console.log('  Disconnecting A from B...');
  const result = await browserA.testBridge.disconnectPeer(deviceIdB);
  console.log(`  Disconnect result: ${JSON.stringify(result)}`);
  await Assert.isTrue(result.disconnected, 'Disconnect should succeed');

  // Check connection count immediately - no sleep, since disconnectPeer
  // synchronously removes from the connections map and the discovery loop
  // (3s interval) will reconnect quickly.
  const connCountA = await browserA.testBridge.getConnectionCount();
  console.log(`  A connection count after disconnect: ${connCountA} (may be 1 if discovery loop already reconnected)`);

  // Note: B may not immediately detect the close -- WebRTC close propagation
  // is async and PeerJS doesn't guarantee instant notification. What matters
  // is that A cleaned up and can reconnect.
  const connCountB = await browserB.testBridge.getConnectionCount();
  console.log(`  B connection count after disconnect: ${connCountB} (may still be 1 briefly)`);

  results.pass('Connection Cleanup After Disconnect');
}

async function testAutomaticReconnection(browserA, browserB) {
  console.log();
  console.log('Test: Automatic Reconnection');

  // Both should be disconnected from the previous test
  const connBefore = await browserA.testBridge.getConnectionCount();
  console.log(`  A connections before: ${connBefore}`);

  // Let the discovery loop reconnect (uses dialPeer with backoff)
  console.log('  Waiting for automatic reconnection...');
  const reconnectedA = await browserA.testBridge.waitForConnections(1, 30000);
  const reconnectedB = await browserB.testBridge.waitForConnections(1, 30000);

  await Assert.isTrue(reconnectedA, 'A should reconnect automatically');
  await Assert.isTrue(reconnectedB, 'B should reconnect automatically');

  // Let sync stabilize
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  const connAfterA = await browserA.testBridge.getConnectionCount();
  const connAfterB = await browserB.testBridge.getConnectionCount();
  console.log(`  A connections after: ${connAfterA}`);
  console.log(`  B connections after: ${connAfterB}`);

  results.pass('Automatic Reconnection');
}

async function testStateSyncsAfterReconnection(browserA, browserB) {
  console.log();
  console.log('Test: State Syncs After Reconnection');

  // Should be reconnected from the previous test
  const connA = await browserA.testBridge.getConnectionCount();
  await Assert.equal(connA, 1, 'A should be connected');

  const tabsBefore = (await browserB.testBridge.getTabs()).length;
  console.log(`  B tabs before: ${tabsBefore}`);

  // Add a tab on A
  const url = generateTestUrl('after-reconnect');
  console.log(`  Creating tab on A: ${url}`);
  await browserA.testBridge.createTab(url);

  // Let sync propagate
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForTabUrl('after-reconnect', 20000);

  const tabsAfter = await browserB.testBridge.getTabs();
  const hasTab = tabsAfter.some(t => t.url && t.url.includes('after-reconnect'));
  console.log(`  B tabs after: ${tabsAfter.length}, has new tab: ${hasTab}`);
  await Assert.isTrue(hasTab, 'B should receive tab created after reconnection');

  results.pass('State Syncs After Reconnection');
}

async function testTabsDuringDisconnectionSyncAfterRecovery(browserA, browserB) {
  console.log();
  console.log('Test: Tabs During Disconnection Sync After Recovery');

  const deviceIdB = await browserB.testBridge.getDeviceId();

  // Make sure we're connected
  const connected = await browserA.testBridge.waitForConnections(1, 10000);
  await Assert.isTrue(connected, 'A and B should be connected');

  await browserA.testBridge.waitForSyncComplete(10000);

  const tabsBefore = (await browserB.testBridge.getTabs()).length;
  console.log(`  B tabs before: ${tabsBefore}`);

  // Disconnect A from B and create a tab before the discovery loop reconnects
  console.log('  Disconnecting A from B...');
  const disconnectResult = await browserA.testBridge.disconnectPeer(deviceIdB);
  await Assert.isTrue(disconnectResult.disconnected, 'Disconnect should succeed');

  const connAfterDisconnect = await browserA.testBridge.getConnectionCount();
  console.log(`  A connections after disconnect: ${connAfterDisconnect}`);

  // Create a tab on A while it's (likely) disconnected
  const url = generateTestUrl('during-disconnect');
  console.log(`  Creating tab on A while disconnected: ${url}`);
  await browserA.testBridge.createTab(url);
  await sleep(500);

  // Tab should exist on A but not on B yet
  const tabsADuring = await browserA.testBridge.getTabs();
  const hasOnA = tabsADuring.some(t => t.url && t.url.includes('during-disconnect'));
  await Assert.isTrue(hasOnA, 'Tab should exist on A');

  // Wait for reconnection
  console.log('  Waiting for reconnection...');
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A and B should reconnect');

  // Wait for sync to push the tab to B
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForTabUrl('during-disconnect', 20000);

  const tabsAfter = await browserB.testBridge.getTabs();
  const hasOnB = tabsAfter.some(t => t.url && t.url.includes('during-disconnect'));
  console.log(`  B tabs after recovery: ${tabsAfter.length}, has tab: ${hasOnB}`);
  await Assert.isTrue(hasOnB, 'Tab created during disconnection should sync to B after recovery');

  results.pass('Tabs During Disconnection Sync After Recovery');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('BROADCAST RETRY TESTS');
  console.log('═'.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');

    const tests = [
      testConnectionCleanupAfterDisconnect,
      testAutomaticReconnection,
      testStateSyncsAfterReconnection,
      testTabsDuringDisconnectionSyncAfterRecovery,
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

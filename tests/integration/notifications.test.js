#!/usr/bin/env node
/**
 * Notification Tests
 *
 * Checks that notifications fire correctly when paired devices connect:
 * - Paired device connection triggers a notification
 * - Unpaired device connection doesn't trigger one
 * - Duplicate notifications are suppressed on reconnect
 * - Notifications reset after simulated restart
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep } = require('../helpers/test-helpers');

const results = new TestResults();

async function testNoNotificationForUnpairedPeer(browserA, browserB) {
  console.log();
  console.log('Test: No Notification for Unpaired Peer');

  // Browsers are connected but not paired -- no notification should fire
  const logA = await browserA.testBridge.getNotificationLog();
  const logB = await browserB.testBridge.getNotificationLog();

  console.log(`  Browser A notifications: ${logA.log.length}`);
  console.log(`  Browser B notifications: ${logB.log.length}`);

  await Assert.equal(logA.log.length, 0, 'Unpaired Browser A should have no notifications');
  await Assert.equal(logB.log.length, 0, 'Unpaired Browser B should have no notifications');

  results.pass('No Notification for Unpaired Peer');
}

async function testNotificationOnPairedConnection(browserA, browserB) {
  console.log();
  console.log('Test: Notification on Paired Device Connection');

  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  // Pair A and B using addPairedDevice (test shortcut, skips the real flow)
  await browserA.testBridge.addPairedDevice(stateB.myDeviceId, 'Test Device B');
  await browserB.testBridge.addPairedDevice(stateA.myDeviceId, 'Test Device A');

  // Restart A to trigger a fresh connection to B (now paired)
  console.log('  Simulating restart on A...');
  await browserA.testBridge.simulateRestart();

  // Wait for reconnection
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect to B');
  await browserA.testBridge.waitForSyncComplete(10000);

  // Check notification log on A -- should have one for B
  const logA = await browserA.testBridge.getNotificationLog();
  console.log(`  Browser A notifications: ${logA.log.length}`);
  console.log(`  Browser A notified peers: [${logA.notifiedPeers.join(', ')}]`);

  await Assert.equal(logA.log.length, 1, 'A should have 1 notification');
  await Assert.equal(logA.log[0].peerId, stateB.myDeviceId, 'Notification should be for B');
  await Assert.isTrue(logA.log[0].message.includes('Test Device B'), 'Notification should include device name');

  // B should also have one for A (B accepted A's incoming connection)
  const logB = await browserB.testBridge.getNotificationLog();
  console.log(`  Browser B notifications: ${logB.log.length}`);

  await Assert.equal(logB.log.length, 1, 'B should have 1 notification');
  await Assert.equal(logB.log[0].peerId, stateA.myDeviceId, 'B notification should be for A');

  results.pass('Notification on Paired Device Connection');
}

async function testNoDuplicateNotificationOnReconnect(browserA, browserB) {
  console.log();
  console.log('Test: No Duplicate Notification on Reconnect');

  const stateB = await browserB.testBridge.getState();

  // A already has a notification for B from the previous test.
  // Disconnect and reconnect -- should NOT produce a second notification.
  console.log('  Disconnecting A from B...');
  await browserA.testBridge.disconnectPeer(stateB.myDeviceId);
  await sleep(2000);

  console.log('  Waiting for automatic reconnection...');
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect');
  await browserA.testBridge.waitForSyncComplete(10000);

  const logA = await browserA.testBridge.getNotificationLog();
  console.log(`  Browser A notifications after reconnect: ${logA.log.length}`);

  await Assert.equal(logA.log.length, 1, 'A should still have only 1 notification (no duplicate)');

  results.pass('No Duplicate Notification on Reconnect');
}

async function testNotificationResetsAfterRestart(browserA, browserB) {
  console.log();
  console.log('Test: Notification Resets After Restart');

  // A has 1 notification from earlier. Restart clears it
  // and should produce a fresh notification when B reconnects.
  const logBefore = await browserA.testBridge.getNotificationLog();
  console.log(`  Notifications before restart: ${logBefore.log.length}`);
  await Assert.equal(logBefore.log.length, 1, 'Should have 1 notification before restart');

  console.log('  Simulating restart on A...');
  await browserA.testBridge.simulateRestart();

  // Wait for reconnect
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect after restart');
  await browserA.testBridge.waitForSyncComplete(10000);

  const logAfter = await browserA.testBridge.getNotificationLog();
  console.log(`  Notifications after restart: ${logAfter.log.length}`);

  await Assert.equal(logAfter.log.length, 1, 'Should have 1 fresh notification after restart');

  results.pass('Notification Resets After Restart');
}

async function main() {
  console.log('='.repeat(60));
  console.log('NOTIFICATION TESTS');
  console.log('='.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');

    // Wait for connection and initial sync
    console.log();
    console.log('Setting up connection...');
    const connA = await browserA.testBridge.waitForConnections(1, 30000);
    const connB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connA && connB, 'Both browsers should connect');
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    console.log('✅ Connected and synced');

    const tests = [
      () => testNoNotificationForUnpairedPeer(browserA, browserB),
      () => testNotificationOnPairedConnection(browserA, browserB),
      () => testNoDuplicateNotificationOnReconnect(browserA, browserB),
      () => testNotificationResetsAfterRestart(browserA, browserB),
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

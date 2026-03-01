#!/usr/bin/env node
/**
 * Notification Tests
 *
 * Checks that notifications fire correctly when paired devices connect/disconnect:
 * - Paired device connection triggers a notification
 * - Unpaired device connection doesn't trigger one
 * - Duplicate notifications are suppressed on reconnect
 * - Notifications reset after simulated restart
 * - Disconnect notification fires after delay
 * - Quick reconnect cancels pending disconnect notification
 * - Disconnect notification clears notifiedPeers so reconnect shows fresh notification
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
  await sleep(1000);

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

async function testDisconnectNotificationAfterDelay(browserA, browserB) {
  console.log();
  console.log('Test: Disconnect Notification After Delay');

  const stateB = await browserB.testBridge.getState();

  // Use a very short delay (100ms) so the notification fires before
  // auto-reconnect can cancel it (discovery runs every 3-5s)
  await browserA.testBridge.setDisconnectNotifyDelay(100);

  // Clear notification state with a restart so we start clean
  console.log('  Simulating restart on A for clean state...');
  await browserA.testBridge.simulateRestart();
  await browserA.testBridge.setDisconnectNotifyDelay(100);
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect');
  await browserA.testBridge.waitForSyncComplete(10000);

  const logBefore = await browserA.testBridge.getNotificationLog();
  const connectCount = logBefore.log.length;
  console.log(`  Notifications after reconnect: ${connectCount} (should have connect notification)`);
  await Assert.isTrue(connectCount >= 1, 'Should have at least 1 connect notification');

  // Prevent race with notification timer.
  await browserA.testBridge.pauseDiscovery();

  // Disconnect A from B
  console.log('  Disconnecting A from B...');
  await browserA.testBridge.disconnectPeer(stateB.myDeviceId);

  // Wait for the close event (async) + 100ms timer to fire
  console.log('  Waiting for disconnect notification (100ms delay)...');
  await sleep(1500);

  const logAfter = await browserA.testBridge.getNotificationLog();
  console.log(`  Notifications after disconnect: ${logAfter.log.length}`);

  // Should have a disconnect notification now
  const disconnectNotif = logAfter.log.find(n => n.message.includes('Disconnected from'));
  await Assert.isTrue(!!disconnectNotif, 'Should have a "Disconnected from" notification');
  console.log(`  Disconnect notification: "${disconnectNotif.message}"`);

  // Resume discovery so subsequent tests can reconnect
  await browserA.testBridge.resumeDiscovery();

  // notifiedPeers clearing is verified in the "Enables Fresh Reconnect" test.
  // We can't check it here because B may have already auto-reconnected,
  // which re-adds the peer to notifiedPeers.

  results.pass('Disconnect Notification After Delay');
}

async function testDisconnectNotificationCancelledByReconnect(browserA, browserB) {
  console.log();
  console.log('Test: Disconnect Notification Cancelled by Quick Reconnect');

  const stateB = await browserB.testBridge.getState();

  // Set a longer delay so we have time to reconnect before it fires
  await browserA.testBridge.setDisconnectNotifyDelay(10000);

  // Restart to get a clean notification state
  console.log('  Simulating restart on A for clean state...');
  await browserA.testBridge.simulateRestart();
  await browserA.testBridge.setDisconnectNotifyDelay(10000);
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect');
  await browserA.testBridge.waitForSyncComplete(10000);

  const logBefore = await browserA.testBridge.getNotificationLog();
  const countBefore = logBefore.log.length;
  console.log(`  Notifications before disconnect: ${countBefore}`);

  // Disconnect
  console.log('  Disconnecting A from B...');
  await browserA.testBridge.disconnectPeer(stateB.myDeviceId);

  // Wait briefly, then reconnect before the 10s timer fires
  await sleep(2000);

  // Reconnect by waiting for auto-reconnect
  console.log('  Waiting for automatic reconnection...');
  const reconnected2 = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected2, 'A should reconnect');

  // Wait past when the original timer would have fired (10s from disconnect)
  console.log('  Waiting past original timer window...');
  await sleep(10000);

  const logAfter = await browserA.testBridge.getNotificationLog();
  const disconnectNotifs = logAfter.log.filter(n => n.message.includes('Disconnected from'));
  console.log(`  Disconnect notifications after reconnect: ${disconnectNotifs.length}`);

  await Assert.equal(disconnectNotifs.length, 0,
    'Should NOT have disconnect notification (reconnect cancelled it)');

  results.pass('Disconnect Notification Cancelled by Quick Reconnect');
}

async function testDisconnectNotificationEnablesReconnectNotification(browserA, browserB) {
  console.log();
  console.log('Test: Disconnect Notification Enables Fresh Reconnect Notification');

  const stateB = await browserB.testBridge.getState();

  // Use very short delay so disconnect notification fires before reconnect
  await browserA.testBridge.setDisconnectNotifyDelay(100);

  // Restart for clean state
  console.log('  Simulating restart on A for clean state...');
  await browserA.testBridge.simulateRestart();
  await browserA.testBridge.setDisconnectNotifyDelay(100);
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect');
  await browserA.testBridge.waitForSyncComplete(10000);

  const logAfterConnect = await browserA.testBridge.getNotificationLog();
  const connectCount = logAfterConnect.log.filter(n => n.message.includes('Connected to')).length;
  console.log(`  Connect notifications: ${connectCount}`);
  await Assert.equal(connectCount, 1, 'Should have 1 connect notification');

  // Prevent race with notification timer.
  await browserA.testBridge.pauseDiscovery();

  // Disconnect and wait for disconnect notification (100ms + close event delay)
  console.log('  Disconnecting and waiting for disconnect notification...');
  await browserA.testBridge.disconnectPeer(stateB.myDeviceId);
  await sleep(1500);

  // Verify disconnect fired
  const logAfterDisconnect = await browserA.testBridge.getNotificationLog();
  const disconnectCount = logAfterDisconnect.log.filter(n => n.message.includes('Disconnected from')).length;
  console.log(`  Disconnect notifications: ${disconnectCount}`);
  await Assert.equal(disconnectCount, 1, 'Should have 1 disconnect notification');

  // Resume discovery so reconnection can happen
  await browserA.testBridge.resumeDiscovery();

  // Now reconnect -- should produce a FRESH connect notification
  // because showPeerDisconnectedNotification removed peer from notifiedPeers
  console.log('  Waiting for reconnection...');
  const reconnected2 = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected2, 'A should reconnect');
  await browserA.testBridge.waitForSyncComplete(10000);

  const logFinal = await browserA.testBridge.getNotificationLog();
  const finalConnects = logFinal.log.filter(n => n.message.includes('Connected to')).length;
  console.log(`  Connect notifications after re-connect: ${finalConnects}`);
  await Assert.equal(finalConnects, 2, 'Should have 2 connect notifications (original + fresh after disconnect)');

  results.pass('Disconnect Notification Enables Fresh Reconnect Notification');
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
      testNoNotificationForUnpairedPeer,
      testNotificationOnPairedConnection,
      testNoDuplicateNotificationOnReconnect,
      testNotificationResetsAfterRestart,
      testDisconnectNotificationAfterDelay,
      testDisconnectNotificationCancelledByReconnect,
      testDisconnectNotificationEnablesReconnectNotification,
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

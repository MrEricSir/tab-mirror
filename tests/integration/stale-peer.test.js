#!/usr/bin/env node
/**
 * Stale Peer Detection Tests
 *
 * Tests ping/pong liveness probing and stale peer cleanup:
 * - Stale peer gets detected and cleaned up after timeout
 * - Ping/pong keeps the connection alive
 * - Reconnection after stale detection works
 * - Last message times are tracked accurately
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testStalePeerDetectedAndCleaned(browserA, browserB) {
  console.log();
  console.log('Test: Stale Peer Detected and Cleaned Up');

  // Check we're connected
  const connA = await browserA.testBridge.getConnectionCount();
  await Assert.equal(connA, 1, 'Browser A should have 1 connection');

  // Mute B first (stops all outgoing data), then set a short timeout on A
  await browserB.testBridge.muteOutgoing(true);
  await browserA.testBridge.setStalePeerTimeout(3000);

  console.log('  Muted outgoing on B, set stale timeout to 3s on A');

  // Wait for the timeout to elapse (extra margin for in-flight data)
  await sleep(5000);

  // Debug: how long since last message?
  const timesBeforeCheck = await browserA.testBridge.getLastMessageTimes();
  for (const [pid, ts] of Object.entries(timesBeforeCheck)) {
    console.log(`  Last message from ${pid}: ${Date.now() - ts}ms ago`);
  }

  // Run health check on A -- should detect B as stale
  console.log('  Running health check on A...');
  await browserA.testBridge.runHealthCheck();

  // Check stale detection via logs. We use logs rather than connection
  // count because the discovery loop (3s in test mode) may reconnect
  // before we can observe 0 connections.
  await sleep(500);
  const logs = await browserA.testBridge.getLogs();
  const hasStaleLog = logs.some(l => l.message && l.message.includes('Stale peer detected'));
  console.log(`  Stale peer log found: ${hasStaleLog}`);
  await Assert.isTrue(hasStaleLog, 'Logs should contain "Stale peer detected"');

  // Reset state for the next tests
  await browserA.testBridge.setStalePeerTimeout(300000);
  await browserB.testBridge.muteOutgoing(false);

  results.pass('Stale Peer Detected and Cleaned Up');
}

async function testPingPongKeepsAlive(browserA, browserB) {
  console.log();
  console.log('Test: Ping/Pong Keeps Connection Alive');

  // Need to reconnect after previous test tore it down
  console.log('  Waiting for reconnection...');
  const reconnectedA = await browserA.testBridge.waitForConnections(1, 30000);
  const reconnectedB = await browserB.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnectedA, 'Browser A should reconnect');
  await Assert.isTrue(reconnectedB, 'Browser B should reconnect');
  await browserA.testBridge.waitForSyncComplete(10000);

  // Set stale timeout to 8s on A -- long enough that ping/pong can keep it alive
  await browserA.testBridge.setStalePeerTimeout(8000);
  console.log('  Set stale timeout to 8s on A');

  // At t=3s: run health check (sends ping, B responds with pong, refreshes A's timer)
  await sleep(3000);
  console.log('  Running health check at t=3s (sends ping)...');
  await browserA.testBridge.runHealthCheck();
  await sleep(1000); // Allow pong response

  // At t=7s: run health check again -- should still be alive because pong refreshed timer
  await sleep(3000);
  console.log('  Running health check at t=7s...');
  await browserA.testBridge.runHealthCheck();
  await sleep(500);

  // A should still be connected to B
  const connA = await browserA.testBridge.getConnectionCount();
  console.log(`  Browser A connections: ${connA}`);
  await Assert.equal(connA, 1, 'Browser A should still have 1 connection (pong kept it alive)');

  // Clean up
  await browserA.testBridge.setStalePeerTimeout(300000);

  results.pass('Ping/Pong Keeps Connection Alive');
}

async function testReconnectionAfterStaleDetection(browserA, browserB) {
  console.log();
  console.log('Test: Reconnection After Stale Detection');

  // Check we're connected
  const connBefore = await browserA.testBridge.getConnectionCount();
  await Assert.equal(connBefore, 1, 'Should start with 1 connection');

  // Mute B, set short timeout on A
  await browserB.testBridge.muteOutgoing(true);
  await browserA.testBridge.setStalePeerTimeout(3000);
  console.log('  Muted B, stale timeout 3s on A');

  // Wait for timeout, then trigger health check to drop the connection
  await sleep(4000);
  await browserA.testBridge.runHealthCheck();
  await sleep(1000);

  const connDropped = await browserA.testBridge.getConnectionCount();
  console.log(`  Connections after stale drop: ${connDropped}`);
  await Assert.equal(connDropped, 0, 'Connection should be dropped');

  // Unmute B and reset timeout so rediscovery can happen
  await browserB.testBridge.muteOutgoing(false);
  await browserA.testBridge.setStalePeerTimeout(300000);
  console.log('  Unmuted B, waiting for rediscovery...');

  // Wait for reconnection
  const reconnectedA = await browserA.testBridge.waitForConnections(1, 45000);
  await Assert.isTrue(reconnectedA, 'A should reconnect to B');

  const reconnectedB = await browserB.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnectedB, 'B should reconnect to A');

  // Wait for sync to settle
  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);
  await sleep(2000);

  // Make sure sync still works: create tab on B, should appear on A
  const testUrl = generateTestUrl('post-stale-sync');
  await browserB.testBridge.createTab(testUrl);
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(15000);

  const tabOnA = await browserA.testBridge.waitForTabUrl(testUrl, 20000);
  console.log(`  Post-stale sync tab on A: ${!!tabOnA}`);
  await Assert.isTrue(!!tabOnA, 'Sync should work after reconnection from stale detection');

  results.pass('Reconnection After Stale Detection');
}

async function testLastMessageTimesTracked(browserA, browserB) {
  console.log();
  console.log('Test: Last Message Times Tracked Accurately');

  // Grab current connection state
  const connA = await browserA.testBridge.getConnectionCount();
  await Assert.equal(connA, 1, 'Should have 1 connection');

  // Grab last message times from A
  const timesBefore = await browserA.testBridge.getLastMessageTimes();
  const peerIds = Object.keys(timesBefore);
  console.log(`  Tracked peers: ${peerIds.length}`);
  await Assert.equal(peerIds.length, 1, 'Should track 1 peer');

  const peerId = peerIds[0];
  const timeBefore = timesBefore[peerId];
  console.log(`  Last message time: ${timeBefore} (${Math.round((Date.now() - timeBefore) / 1000)}s ago)`);
  await Assert.isTrue(timeBefore > 0, 'Last message time should be positive');

  // Wait, then create a tab on B (triggers sync data to A which updates the timestamp)
  await sleep(2000);
  const testUrl = generateTestUrl('timestamp-test');
  await browserB.testBridge.createTab(testUrl);
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Get times again -- B's timestamp should have increased
  const timesAfter = await browserA.testBridge.getLastMessageTimes();
  const timeAfter = timesAfter[peerId];
  console.log(`  Updated time: ${timeAfter} (${Math.round((Date.now() - timeAfter) / 1000)}s ago)`);
  console.log(`  Time increased by: ${timeAfter - timeBefore}ms`);
  await Assert.isTrue(timeAfter > timeBefore, 'Timestamp should increase after receiving data');

  results.pass('Last Message Times Tracked Accurately');
}

async function main() {
  console.log('='.repeat(60));
  console.log('STALE PEER DETECTION TESTS');
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
    console.log('Waiting for connection...');
    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'Browser A should connect');
    await Assert.isTrue(connectedB, 'Browser B should connect');

    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('✅ Connected and synced');

    const tests = [
      testStalePeerDetectedAndCleaned,
      testPingPongKeepsAlive,
      testReconnectionAfterStaleDetection,
      testLastMessageTimesTracked,
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

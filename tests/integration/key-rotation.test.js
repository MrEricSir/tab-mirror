#!/usr/bin/env node
/**
 * Key Rotation Integration Tests
 *
 * Tests the in-band key rotation protocol between two paired browsers:
 * - Rotate key from one side, verify both peers update
 * - Verify reconnection uses the new key (HMAC auth with rotated key)
 * - Verify key generation increments correctly across multiple rotations
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep } = require('../helpers/test-helpers');

const results = new TestResults();

// Valid base64-encoded 32-byte key (both peers must share the same key)
const SHARED_KEY = Buffer.from('A'.repeat(32)).toString('base64');

async function testKeyRotation(browserA, browserB) {
  console.log();
  console.log('Test: Key Rotation Updates Both Peers');

  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  // Pair A and B with matching shared keys (valid base64 for crypto operations)
  await browserA.testBridge.addPairedDevice(stateB.myDeviceId, 'Test Device B', SHARED_KEY);
  await browserB.testBridge.addPairedDevice(stateA.myDeviceId, 'Test Device A', SHARED_KEY);

  // Verify initial key generation is 1
  const genA1 = await browserA.testBridge.getKeyGeneration(stateB.myDeviceId);
  const genB1 = await browserB.testBridge.getKeyGeneration(stateA.myDeviceId);
  console.log(`  Initial key gen A->B: ${genA1.keyGeneration}, B->A: ${genB1.keyGeneration}`);
  await Assert.equal(genA1.keyGeneration, 1, 'A initial generation should be 1');
  await Assert.equal(genB1.keyGeneration, 1, 'B initial generation should be 1');

  // Rotate key from A's side
  console.log('  Rotating key from A...');
  const rotateResult = await browserA.testBridge.rotateKey(stateB.myDeviceId);
  console.log(`  Rotate result: ${JSON.stringify(rotateResult)}`);
  await Assert.isTrue(rotateResult.success, 'Rotation should succeed');
  await Assert.equal(rotateResult.generation, 2, 'New generation should be 2');

  // Wait for the KEY_ROTATE_ACK to be processed
  await sleep(3000);

  // Check key generation on both sides
  const genA2 = await browserA.testBridge.getKeyGeneration(stateB.myDeviceId);
  const genB2 = await browserB.testBridge.getKeyGeneration(stateA.myDeviceId);
  console.log(`  After rotation A->B: ${genA2.keyGeneration}, B->A: ${genB2.keyGeneration}`);
  await Assert.equal(genA2.keyGeneration, 2, 'A should be at generation 2');
  await Assert.equal(genB2.keyGeneration, 2, 'B should be at generation 2');

  results.pass('Key Rotation Updates Both Peers');
}

async function testReconnectWithNewKey(browserA, browserB) {
  console.log();
  console.log('Test: Reconnect Uses New Key');

  const stateB = await browserB.testBridge.getState();

  // Force auth on next connection so reconnection goes through authenticateConnection
  // which uses HMAC with the shared key (now rotated)
  await browserA.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });
  await browserB.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });

  // Restart A to trigger a fresh authenticated connection with the new key
  console.log('  Simulating restart on A...');
  await browserA.testBridge.simulateRestart();

  // Wait for reconnection (auth happens during reconnect)
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect to B (auth with rotated key)');
  console.log('  Reconnected successfully');

  // Wait for sync
  await browserA.testBridge.waitForSyncComplete(15000);

  // Key generation should still be 2 (from previous rotation)
  const genA = await browserA.testBridge.getKeyGeneration(stateB.myDeviceId);
  console.log(`  Key generation after reconnect: ${genA.keyGeneration}`);
  await Assert.equal(genA.keyGeneration, 2, 'Key generation should still be 2 after reconnect');

  results.pass('Reconnect Uses New Key');
}

async function testMultipleRotations(browserA, browserB) {
  console.log();
  console.log('Test: Multiple Key Rotations');

  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  // Rotate from B's side this time
  console.log('  Rotating key from B...');
  const rotateResult = await browserB.testBridge.rotateKey(stateA.myDeviceId);
  console.log(`  Rotate result: ${JSON.stringify(rotateResult)}`);
  await Assert.isTrue(rotateResult.success, 'Rotation from B should succeed');
  await Assert.equal(rotateResult.generation, 3, 'New generation should be 3');

  // Wait for ACK
  await sleep(3000);

  // Both should be at generation 3
  const genA = await browserA.testBridge.getKeyGeneration(stateB.myDeviceId);
  const genB = await browserB.testBridge.getKeyGeneration(stateA.myDeviceId);
  console.log(`  After second rotation A->B: ${genA.keyGeneration}, B->A: ${genB.keyGeneration}`);
  await Assert.equal(genA.keyGeneration, 3, 'A should be at generation 3');
  await Assert.equal(genB.keyGeneration, 3, 'B should be at generation 3');

  // Rotate once more from A
  console.log('  Rotating key from A again...');
  const rotateResult2 = await browserA.testBridge.rotateKey(stateB.myDeviceId);
  await Assert.isTrue(rotateResult2.success, 'Third rotation should succeed');
  await Assert.equal(rotateResult2.generation, 4, 'New generation should be 4');

  await sleep(3000);

  const genA2 = await browserA.testBridge.getKeyGeneration(stateB.myDeviceId);
  const genB2 = await browserB.testBridge.getKeyGeneration(stateA.myDeviceId);
  console.log(`  After third rotation A->B: ${genA2.keyGeneration}, B->A: ${genB2.keyGeneration}`);
  await Assert.equal(genA2.keyGeneration, 4, 'A should be at generation 4');
  await Assert.equal(genB2.keyGeneration, 4, 'B should be at generation 4');

  results.pass('Multiple Key Rotations');
}

async function testReconnectAfterMultipleRotations(browserA, browserB) {
  console.log();
  console.log('Test: Reconnect After Multiple Rotations');

  const stateB = await browserB.testBridge.getState();

  // Force auth so we verify the latest key is used for HMAC challenge/response
  await browserA.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });
  await browserB.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });

  // Restart A
  console.log('  Simulating restart on A...');
  await browserA.testBridge.simulateRestart();

  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  await Assert.isTrue(reconnected, 'A should reconnect (auth with generation 4 key)');
  console.log('  Reconnected successfully');

  await browserA.testBridge.waitForSyncComplete(15000);

  // Generation should still be 4
  const genA = await browserA.testBridge.getKeyGeneration(stateB.myDeviceId);
  console.log(`  Key generation after reconnect: ${genA.keyGeneration}`);
  await Assert.equal(genA.keyGeneration, 4, 'Key generation should be 4 after reconnect');

  results.pass('Reconnect After Multiple Rotations');
}

async function main() {
  console.log('='.repeat(60));
  console.log('KEY ROTATION TESTS');
  console.log('='.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    // Wait for connection and initial sync
    console.log();
    console.log('Setting up connection...');
    const connA = await browserA.testBridge.waitForConnections(1, 30000);
    const connB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connA && connB, 'Both browsers should connect');
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    console.log('Connected and synced');

    const tests = [
      testKeyRotation,
      testReconnectWithNewKey,
      testMultipleRotations,
      testReconnectAfterMultipleRotations,
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

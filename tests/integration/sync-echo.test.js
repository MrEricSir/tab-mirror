#!/usr/bin/env node
/**
 * Sync Echo / Loop Prevention Tests
 *
 * Verifies that tabs synced between instances don't create infinite loops.
 * This simulates the scenario where Firefox Sync's "send tab to device"
 * opens a URL on one instance while Tab Mirror is also syncing - the tab
 * should propagate once to each peer, not multiply endlessly.
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

/**
 * Two instances: a tab created on A should sync to B exactly once,
 * and subsequent sync cycles should not create duplicates on either side.
 */
async function testTwoInstanceNoEcho(browserA, browserB) {
  console.log();
  console.log('Test: Two-Instance Sync Echo Prevention');

  // Record starting state
  const initialCountA = (await browserA.testBridge.getTabs()).length;
  const initialCountB = (await browserB.testBridge.getTabs()).length;
  console.log(`  Initial tabs - A: ${initialCountA}, B: ${initialCountB}`);

  // Simulate "send tab to device" - a new tab appears on A
  const sentUrl = generateTestUrl('sent-tab-echo');
  console.log(`  Creating tab on A (simulating "send to device")`);
  const tab = await browserA.testBridge.createTab(sentUrl);
  await browserA.testBridge.waitForTabLoad(tab.id);

  const expectedCount = initialCountA + 1;

  // Wait for the tab to sync to B
  console.log('  Waiting for tab to sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const tabB = await browserB.testBridge.waitForTabUrl('sent-tab-echo', 20000);
  await Assert.isTrue(!!tabB, 'Tab should sync to B');

  // Let sync echo round-trips settle
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Force several extra sync cycles to stress-test stability
  console.log('  Forcing additional sync cycles...');
  for (let i = 0; i < 3; i++) {
    await browserA.testBridge.triggerSync();
    await sleep(500);
    await browserB.testBridge.triggerSync();
    await sleep(500);
  }
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Tab count should be stable - no duplicates
  const finalCountA = (await browserA.testBridge.getTabs()).length;
  const finalCountB = (await browserB.testBridge.getTabs()).length;
  console.log(`  Final tabs - A: ${finalCountA}, B: ${finalCountB} (expected: ${expectedCount})`);

  await Assert.equal(finalCountA, expectedCount, 'A should have exactly one new tab');
  await Assert.equal(finalCountB, expectedCount, 'B should have exactly one copy');

  // Verify sync counter is stable (no ongoing loop)
  const counterBefore = (await browserA.testBridge.getState()).syncCounter;
  await sleep(3000);
  const counterAfter = (await browserA.testBridge.getState()).syncCounter;
  console.log(`  Sync counter - before: ${counterBefore}, after: ${counterAfter}`);
  await Assert.equal(counterAfter, counterBefore, 'Sync counter should stabilize (no loop)');

  results.pass('Two-Instance Sync Echo Prevention');
}

/**
 * Three instances: a tab created on A should sync to B and C exactly once
 * each, without duplicates or echo loops across the mesh.
 */
async function testThreeInstanceNoEcho(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Three-Instance Sync Echo Prevention');

  const initialCountA = (await browserA.testBridge.getTabs()).length;
  const initialCountB = (await browserB.testBridge.getTabs()).length;
  const initialCountC = (await browserC.testBridge.getTabs()).length;
  console.log(`  Initial tabs - A: ${initialCountA}, B: ${initialCountB}, C: ${initialCountC}`);

  // Simulate "send tab to device" on A
  const sentUrl = generateTestUrl('sent-tab-mesh-echo');
  console.log(`  Creating tab on A (simulating "send to device")`);
  const tab = await browserA.testBridge.createTab(sentUrl);
  await browserA.testBridge.waitForTabLoad(tab.id);

  const expectedCount = initialCountA + 1;

  // Wait for tab to reach B and C
  console.log('  Waiting for tab to sync to B and C...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const tabB = await browserB.testBridge.waitForTabUrl('sent-tab-mesh-echo', 20000);
  const tabC = await browserC.testBridge.waitForTabUrl('sent-tab-mesh-echo', 20000);
  await Assert.isTrue(!!tabB, 'Tab should sync to B');
  await Assert.isTrue(!!tabC, 'Tab should sync to C');

  // Let all echo round-trips settle across the mesh
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // Force extra sync cycles from each peer to stress-test
  console.log('  Forcing additional sync cycles from all peers...');
  for (let i = 0; i < 3; i++) {
    await browserA.testBridge.triggerSync();
    await browserB.testBridge.triggerSync();
    await browserC.testBridge.triggerSync();
    await sleep(1000);
  }
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // Tab count should be stable on all three
  const finalCountA = (await browserA.testBridge.getTabs()).length;
  const finalCountB = (await browserB.testBridge.getTabs()).length;
  const finalCountC = (await browserC.testBridge.getTabs()).length;
  console.log(`  Final tabs - A: ${finalCountA}, B: ${finalCountB}, C: ${finalCountC} (expected: ${expectedCount})`);

  await Assert.equal(finalCountA, expectedCount, 'A should have exactly one new tab');
  await Assert.equal(finalCountB, expectedCount, 'B should have exactly one copy');
  await Assert.equal(finalCountC, expectedCount, 'C should have exactly one copy');

  results.pass('Three-Instance Sync Echo Prevention');
}

/**
 * Simultaneous "send tab to device" on two instances at once.
 * Each tab should appear exactly once on each peer, no duplication.
 */
async function testSimultaneousSendNoEcho(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Simultaneous Send-to-Device No Echo');

  const initialCountA = (await browserA.testBridge.getTabs()).length;
  console.log(`  Initial tab count: ${initialCountA}`);

  // Simulate "send tab to device" arriving on A and B at the same time
  const urlFromA = generateTestUrl('sent-simultaneous-a');
  const urlFromB = generateTestUrl('sent-simultaneous-b');

  console.log('  Creating tabs simultaneously on A and B...');
  const [tabA, tabB] = await Promise.all([
    browserA.testBridge.createTab(urlFromA),
    browserB.testBridge.createTab(urlFromB),
  ]);
  await Promise.all([
    browserA.testBridge.waitForTabLoad(tabA.id),
    browserB.testBridge.waitForTabLoad(tabB.id),
  ]);

  const expectedCount = initialCountA + 2;

  // Wait for convergence
  console.log('  Waiting for convergence...');
  await sleep(1500);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // Both URLs should be on all browsers
  for (const [name, browser] of [['A', browserA], ['B', browserB], ['C', browserC]]) {
    const hasA = await browser.testBridge.waitForTabUrl('sent-simultaneous-a', 20000);
    const hasB = await browser.testBridge.waitForTabUrl('sent-simultaneous-b', 20000);
    await Assert.isTrue(!!hasA, `Browser ${name} should have tab from A`);
    await Assert.isTrue(!!hasB, `Browser ${name} should have tab from B`);
  }

  // Force extra sync cycles
  console.log('  Forcing additional sync cycles...');
  for (let i = 0; i < 3; i++) {
    await browserA.testBridge.triggerSync();
    await browserB.testBridge.triggerSync();
    await browserC.testBridge.triggerSync();
    await sleep(1000);
  }
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // No duplicates
  const finalCountA = (await browserA.testBridge.getTabs()).length;
  const finalCountB = (await browserB.testBridge.getTabs()).length;
  const finalCountC = (await browserC.testBridge.getTabs()).length;
  console.log(`  Final tabs - A: ${finalCountA}, B: ${finalCountB}, C: ${finalCountC} (expected: ${expectedCount})`);

  await Assert.equal(finalCountA, expectedCount, 'A should have exactly 2 new tabs');
  await Assert.equal(finalCountB, expectedCount, 'B should have exactly 2 new tabs');
  await Assert.equal(finalCountC, expectedCount, 'C should have exactly 2 new tabs');

  results.pass('Simultaneous Send-to-Device No Echo');
}

async function main() {
  console.log('='.repeat(60));
  console.log('SYNC ECHO / LOOP PREVENTION TESTS');
  console.log('='.repeat(60));

  // --- Two-instance test ---
  let browserA, browserB;

  try {
    console.log();
    console.log('Launching two browsers for echo test...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    // Wait for connection + initial sync
    await browserA.testBridge.waitForConnections(1, 30000);
    await browserB.testBridge.waitForConnections(1, 30000);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    try {
      await testTwoInstanceNoEcho(browserA, browserB);
    } catch (error) {
      results.error('testTwoInstanceNoEcho', error);
    }
  } catch (error) {
    results.error('Two-Instance Setup', error);
  } finally {
    console.log();
    console.log('Cleaning up two-instance browsers...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }

  // --- Three-instance tests ---
  let browserX, browserY, browserZ;

  try {
    console.log();
    console.log('Launching three browsers for mesh echo tests...');
    browserX = await launchBrowser();
    console.log('  Browser X launched');
    await sleep(2000);

    browserY = await launchBrowser();
    console.log('  Browser Y launched');
    await sleep(2000);

    browserZ = await launchBrowser();
    console.log('  Browser Z launched');
    await sleep(2000);

    // Wait for mesh to form
    console.log('  Waiting for mesh network...');
    await browserX.testBridge.waitForConnections(2, 45000);
    await browserY.testBridge.waitForConnections(2, 45000);
    await browserZ.testBridge.waitForConnections(2, 45000);

    // Wait for all synced peers
    const allBrowsers = [
      { name: 'X', bridge: browserX.testBridge },
      { name: 'Y', bridge: browserY.testBridge },
      { name: 'Z', bridge: browserZ.testBridge },
    ];

    const syncDeadline = Date.now() + 45000;
    for (const { name, bridge } of allBrowsers) {
      while (Date.now() < syncDeadline) {
        const peers = await bridge.getSyncedPeers();
        if (peers.length >= 2) {
          break;
        }
        console.log(`  Browser ${name}: ${peers.length}/2 synced peers, waiting...`);
        await sleep(2000);
      }
    }

    // Initial sync
    await browserX.testBridge.waitForSyncComplete(15000);
    await browserY.testBridge.waitForSyncComplete(15000);
    await browserZ.testBridge.waitForSyncComplete(15000);
    await sleep(1000);
    console.log('  Mesh ready');

    const tests = [
      testThreeInstanceNoEcho,
      testSimultaneousSendNoEcho,
    ];

    for (const test of tests) {
      try {
        await test(browserX, browserY, browserZ);
      } catch (error) {
        results.error(test.name || 'Unknown Test', error);
      }
    }
  } catch (error) {
    results.error('Three-Instance Setup', error);
  } finally {
    console.log();
    console.log('Cleaning up three-instance browsers...');
    await cleanupBrowser(browserX);
    await cleanupBrowser(browserY);
    await cleanupBrowser(browserZ);
  }

  results.summary();
  process.exit(results.exitCode());
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

main();

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

/**
 * Redirect bounce: A navigates from URL1 to URL2, B mirrors URL2,
 * then B's mirror tab "redirects" back to URL1 (YouTube-style).
 * A should NOT revert to URL1 - bounce detection should catch it.
 */
async function testRedirectBounceDoesNotRevertOriginator(browserA, browserB) {
  console.log();
  console.log('Test: Redirect Bounce Does Not Revert Originator');

  const url1 = generateTestUrl('bounce-origin');
  const url2 = generateTestUrl('bounce-target');

  // Create tab on A at URL1
  console.log(`  Creating tab on A at URL1`);
  const tab = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(tab.id);

  // Wait for sync to B
  await browserA.testBridge.waitForSyncComplete(10000);
  const mirrorResult = await browserB.testBridge.waitForTabUrl('bounce-origin', 20000);
  await Assert.isTrue(!!mirrorResult, 'B should mirror the tab');
  await browserB.testBridge.waitForSyncComplete(10000);

  // Let initial echo settle
  await browserA.testBridge.triggerSync();
  await browserB.testBridge.triggerSync();
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Navigate A to URL2 (user clicks a link)
  console.log('  Navigating A to URL2 (simulating user click)');
  await browserA.testBridge.updateTab(tab.id, { url: url2 });
  await browserA.testBridge.waitForTabLoad(tab.id);

  // Wait for URL2 to propagate to B and echo to settle
  await browserA.testBridge.waitForSyncComplete(10000);
  const mirrorUpdate = await browserB.testBridge.waitForTabUrl('bounce-target', 20000);
  await Assert.isTrue(!!mirrorUpdate, 'B should mirror URL2');
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserA.testBridge.triggerSync();
  await browserB.testBridge.triggerSync();
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Find B's mirror tab
  const tabsB = await browserB.testBridge.getTabs();
  const mirrorTab = tabsB.find(t => t.url && t.url.includes('bounce-target'));
  await Assert.isTrue(!!mirrorTab, 'B should have mirror tab at URL2');
  console.log(`  B mirror tab id: ${mirrorTab.id}`);

  // Simulate redirect: navigate B's mirror back to URL1.
  // Disable redirect suppression so the broadcast goes through immediately.
  await browserB.testBridge.setRedirectSuppressionWindow(0);
  console.log('  Simulating redirect on B: navigating mirror back to URL1');
  await browserB.testBridge.updateTab(mirrorTab.id, { url: url1 });
  await sleep(1000);

  // Force sync from B to A and let it settle
  await browserB.testBridge.triggerSync();
  await sleep(2000);
  for (let i = 0; i < 3; i++) {
    await browserA.testBridge.triggerSync();
    await browserB.testBridge.triggerSync();
    await sleep(1000);
  }
  await browserA.testBridge.waitForSyncComplete(10000);

  // A should still have URL2, NOT URL1
  const tabsA = await browserA.testBridge.getTabs();
  const aTab = tabsA.find(t => t.url && t.url.includes('bounce-'));
  console.log(`  A's tab URL after bounce: ${aTab ? aTab.url : 'NOT FOUND'}`);
  await Assert.isTrue(
    aTab && aTab.url.includes('bounce-target'),
    'A should still have URL2 (bounce detection prevents revert to URL1)'
  );

  // Reset redirect suppression
  await browserB.testBridge.setRedirectSuppressionWindow(10000);

  results.pass('Redirect Bounce Does Not Revert Originator');
}

/**
 * Legitimate URL change from peer should NOT be suppressed.
 * A navigates URL1 -> URL2, B mirrors, then B navigates to URL3.
 * A should receive URL3 since it's a new destination, not a bounce.
 */
async function testLegitimateUrlChangeNotSuppressed(browserA, browserB) {
  console.log();
  console.log('Test: Legitimate URL Change Not Suppressed');

  const url1 = generateTestUrl('legit-initial');
  const url2 = generateTestUrl('legit-navigate');
  const url3 = generateTestUrl('legit-new-destination');

  // A creates tab at URL1
  console.log('  Creating tab on A at URL1');
  const tab = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(tab.id);

  // Sync to B
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForTabUrl('legit-initial', 20000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await sleep(2000);

  // A navigates to URL2
  console.log('  Navigating A to URL2');
  await browserA.testBridge.updateTab(tab.id, { url: url2 });
  await browserA.testBridge.waitForTabLoad(tab.id);

  // Sync to B
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForTabUrl('legit-navigate', 20000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserA.testBridge.triggerSync();
  await browserB.testBridge.triggerSync();
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Navigate B's mirror to URL3 (legitimate new destination, not a bounce)
  const tabsB = await browserB.testBridge.getTabs();
  const mirrorTab = tabsB.find(t => t.url && t.url.includes('legit-navigate'));
  await Assert.isTrue(!!mirrorTab, 'B should have mirror at URL2');

  await browserB.testBridge.setRedirectSuppressionWindow(0);
  console.log('  Navigating B mirror to URL3 (legitimate new destination)');
  await browserB.testBridge.updateTab(mirrorTab.id, { url: url3 });
  await sleep(1000);

  // Force sync from B to A
  await browserB.testBridge.triggerSync();
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // A should receive URL3 (not a bounce - genuinely new URL)
  const aTab = await browserA.testBridge.waitForTabUrl('legit-new-destination', 20000);
  console.log(`  A received URL3: ${aTab ? aTab.url : 'NOT FOUND'}`);
  await Assert.isTrue(!!aTab, 'A should receive URL3 (legitimate update goes through)');

  // Reset redirect suppression
  await browserB.testBridge.setRedirectSuppressionWindow(10000);

  results.pass('Legitimate URL Change Not Suppressed');
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

    const twoInstanceTests = [
      testTwoInstanceNoEcho,
      testRedirectBounceDoesNotRevertOriginator,
      testLegitimateUrlChangeNotSuppressed,
    ];

    for (const test of twoInstanceTests) {
      try {
        await test(browserA, browserB);
      } catch (error) {
        results.error(test.name || 'Unknown Test', error);
      }
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

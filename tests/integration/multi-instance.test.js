#!/usr/bin/env node
/**
 * Multi-Instance Tests
 *
 * Checks sync across 3+ browser instances:
 * - Mesh network formation
 * - Multi-peer sync
 * - Change propagation to all peers
 * - No conflicts or race conditions
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testThreeWayConnection(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Three-Way Connection');

  const deviceIdA = await browserA.testBridge.getDeviceId();
  const deviceIdB = await browserB.testBridge.getDeviceId();
  const deviceIdC = await browserC.testBridge.getDeviceId();

  console.log(`  Device A: ${deviceIdA}`);
  console.log(`  Device B: ${deviceIdB}`);
  console.log(`  Device C: ${deviceIdC}`);

  // Wait for all connections (45s allows for listAllPeers + dial + handshake)
  console.log('  Waiting for mesh network to form...');
  const connectedA = await browserA.testBridge.waitForConnections(2, 45000);
  const connectedB = await browserB.testBridge.waitForConnections(2, 45000);
  const connectedC = await browserC.testBridge.waitForConnections(2, 45000);

  await Assert.isTrue(connectedA, 'Browser A should connect to B and C');
  await Assert.isTrue(connectedB, 'Browser B should connect to A and C');
  await Assert.isTrue(connectedC, 'Browser C should connect to A and B');

  // Wait for all syncs to complete (connections open but sync data may
  // still be exchanging -- poll until each browser has 2 synced peers)
  const allBrowsers = [
    { name: 'A', bridge: browserA.testBridge },
    { name: 'B', bridge: browserB.testBridge },
    { name: 'C', bridge: browserC.testBridge }
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

  const peersA = await browserA.testBridge.getSyncedPeers();
  const peersB = await browserB.testBridge.getSyncedPeers();
  const peersC = await browserC.testBridge.getSyncedPeers();

  console.log(`  Browser A peers: [${peersA.join(', ')}]`);
  console.log(`  Browser B peers: [${peersB.join(', ')}]`);
  console.log(`  Browser C peers: [${peersC.join(', ')}]`);

  // Check mesh connectivity
  await Assert.equal(peersA.length, 2, 'Browser A should have 2 peers');
  await Assert.equal(peersB.length, 2, 'Browser B should have 2 peers');
  await Assert.equal(peersC.length, 2, 'Browser C should have 2 peers');

  results.pass('Three-Way Connection');
}

async function testTabPropagationToAllPeers(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Tab Propagation to All Peers');

  const initialCountA = (await browserA.testBridge.getTabs()).length;
  const initialCountB = (await browserB.testBridge.getTabs()).length;
  const initialCountC = (await browserC.testBridge.getTabs()).length;

  console.log(`  Initial - A: ${initialCountA}, B: ${initialCountB}, C: ${initialCountC}`);

  // Create tab with unique URL in A
  const uniqueUrl = generateTestUrl('multi-propagation');
  console.log(`  Creating tab in Browser A`);
  const propTab = await browserA.testBridge.createTab(uniqueUrl);
  await browserA.testBridge.waitForTabLoad(propTab.id);

  const newCountA = (await browserA.testBridge.getTabs()).length;
  console.log(`  Browser A: ${newCountA} tabs`);

  // Wait for sync on A, then check URL appears in B and C
  console.log('  Waiting for sync to propagate...');
  await browserA.testBridge.waitForSyncComplete(10000);

  console.log('  Waiting for URL to appear in Browser B...');
  const tabB = await browserB.testBridge.waitForTabUrl(uniqueUrl, 20000);
  console.log('  Waiting for URL to appear in Browser C...');
  const tabC = await browserC.testBridge.waitForTabUrl(uniqueUrl, 20000);

  // Check A has it too
  const tabsFromA = await browserA.testBridge.getTabs();
  const urlInA = tabsFromA.some(tab => tab.url && tab.url.includes(uniqueUrl));

  console.log(`  Tab found - A: ${urlInA}, B: ${!!tabB}, C: ${!!tabC}`);

  await Assert.isTrue(urlInA, 'URL should be in Browser A');
  await Assert.isTrue(!!tabB, 'URL should be in Browser B');
  await Assert.isTrue(!!tabC, 'URL should be in Browser C');

  results.pass('Tab Propagation to All Peers');
}

async function testSimultaneousChanges(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Simultaneous Changes from Multiple Peers');

  const initialCount = (await browserA.testBridge.getTabs()).length;
  console.log(`  Initial tab count: ${initialCount}`);

  // Create tabs on A and B at the same time with unique URLs
  const urlFromA = generateTestUrl('from-a');
  const urlFromB = generateTestUrl('from-b');

  console.log('  Creating tabs simultaneously in A and B...');
  await Promise.all([
    browserA.testBridge.createTab(urlFromA),
    browserB.testBridge.createTab(urlFromB)
  ]);

  // Wait for convergence
  console.log('  Waiting for convergence...');
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // Both URLs should exist in all browsers
  const tabsFromA = await browserA.testBridge.getTabs();
  const tabsFromB = await browserB.testBridge.getTabs();
  const tabsFromC = await browserC.testBridge.getTabs();

  console.log(`  Looking for URL A: ${urlFromA}`);
  console.log(`  Looking for URL B: ${urlFromB}`);
  console.log(`  Browser A tabs: ${tabsFromA.map(t => t.url).join(', ')}`);

  const aHasUrlA = tabsFromA.some(tab => tab.url && tab.url.includes(urlFromA));
  const aHasUrlB = tabsFromA.some(tab => tab.url && tab.url.includes(urlFromB));
  const bHasUrlA = tabsFromB.some(tab => tab.url && tab.url.includes(urlFromA));
  const bHasUrlB = tabsFromB.some(tab => tab.url && tab.url.includes(urlFromB));
  const cHasUrlA = tabsFromC.some(tab => tab.url && tab.url.includes(urlFromA));
  const cHasUrlB = tabsFromC.some(tab => tab.url && tab.url.includes(urlFromB));

  console.log(`  Browser A has both URLs: ${aHasUrlA && aHasUrlB} (A:${aHasUrlA}, B:${aHasUrlB})`);
  console.log(`  Browser B has both URLs: ${bHasUrlA && bHasUrlB} (A:${bHasUrlA}, B:${bHasUrlB})`);
  console.log(`  Browser C has both URLs: ${cHasUrlA && cHasUrlB} (A:${cHasUrlA}, B:${cHasUrlB})`);

  await Assert.isTrue(aHasUrlA && aHasUrlB, 'Browser A should have both tabs');
  await Assert.isTrue(bHasUrlA && bHasUrlB, 'Browser B should have both tabs');
  await Assert.isTrue(cHasUrlA && cHasUrlB, 'Browser C should have both tabs');

  results.pass('Simultaneous Changes from Multiple Peers');
}

async function testChainPropagation(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Chain Propagation (A → mesh → C)');

  // Create tab with unique URL in A
  const uniqueUrl = generateTestUrl('chain-test');
  console.log(`  Creating tab in Browser A`);
  const chainTab = await browserA.testBridge.createTab(uniqueUrl);
  await browserA.testBridge.waitForTabLoad(chainTab.id);

  // Should propagate through the mesh to reach C
  console.log('  Waiting for propagation through mesh...');
  await browserA.testBridge.waitForSyncComplete(10000);

  console.log('  Waiting for URL to appear in Browser C...');
  const tabInC = await browserC.testBridge.waitForTabUrl(uniqueUrl, 20000);

  console.log(`  Tab found in C: ${!!tabInC}`);

  await Assert.isTrue(!!tabInC, 'Change should propagate from A to C through mesh');

  results.pass('Chain Propagation');
}

async function testThreeWayGroupSync(browserA, browserB, browserC) {
  console.log();
  console.log('Test: Three-Way Group Sync');

  // Create tabs and group them on A
  const t1 = await browserA.testBridge.createTab(generateTestUrl('mesh-grp-1'));
  await browserA.testBridge.waitForTabLoad(t1.id);
  const t2 = await browserA.testBridge.createTab(generateTestUrl('mesh-grp-2'));
  await browserA.testBridge.waitForTabLoad(t2.id);

  try {
    await browserA.testBridge.groupTabs([t1.id, t2.id], 'Mesh Group', 'blue');
  } catch (error) {
    if (error.message && error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Three-Way Group Sync (skipped)');
      return;
    }
    throw error;
  }
  await sleep(1000);

  // Wait for sync to propagate through mesh
  console.log('  Waiting for group to propagate to all peers...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserC.testBridge.waitForSyncComplete(10000);

  // Check group exists on B
  const groupsB = await browserB.testBridge.getGroupCount();
  const meshGroupB = groupsB.groupDetails.find(g => g.title === 'Mesh Group');
  console.log(`  B has Mesh Group: ${!!meshGroupB} (${meshGroupB ? meshGroupB.tabCount + ' tabs' : 'N/A'})`);
  await Assert.isTrue(!!meshGroupB, 'B should have Mesh Group');
  await Assert.equal(meshGroupB.tabCount, 2, 'B Mesh Group should have 2 tabs');

  // Check group exists on C
  const groupsC = await browserC.testBridge.getGroupCount();
  const meshGroupC = groupsC.groupDetails.find(g => g.title === 'Mesh Group');
  console.log(`  C has Mesh Group: ${!!meshGroupC} (${meshGroupC ? meshGroupC.tabCount + ' tabs' : 'N/A'})`);
  await Assert.isTrue(!!meshGroupC, 'C should have Mesh Group');
  await Assert.equal(meshGroupC.tabCount, 2, 'C Mesh Group should have 2 tabs');

  // Check group properties match
  await Assert.equal(meshGroupB.color, 'blue', 'B Mesh Group should be blue');
  await Assert.equal(meshGroupC.color, 'blue', 'C Mesh Group should be blue');

  results.pass('Three-Way Group Sync');
}

async function testFourPeerMesh() {
  console.log();
  console.log('Test: Four-Peer Mesh');

  let browsers = [];

  try {
    // Launch 4 browsers
    for (let i = 0; i < 4; i++) {
      const b = await launchBrowser();
      browsers.push(b);
      console.log(`  Browser ${i + 1} launched`);
      if (i < 3) {
        await sleep(3000);
      }
    }

    // Wait for full mesh (each peer needs 3 connections)
    console.log('  Waiting for 4-way mesh to form...');
    for (let i = 0; i < browsers.length; i++) {
      const connected = await browsers[i].testBridge.waitForConnections(3, 60000);
      await Assert.isTrue(connected, `Browser ${i + 1} should have 3 connections`);
    }

    // Wait until all synced peers reach 3
    const syncDeadline = Date.now() + 60000;
    for (let i = 0; i < browsers.length; i++) {
      while (Date.now() < syncDeadline) {
        const peers = await browsers[i].testBridge.getSyncedPeers();
        if (peers.length >= 3) {
          break;
        }
        console.log(`  Browser ${i + 1}: ${peers.length}/3 synced peers, waiting...`);
        await sleep(2000);
      }
    }

    // Each browser should see 3 synced peers
    for (let i = 0; i < browsers.length; i++) {
      const peers = await browsers[i].testBridge.getSyncedPeers();
      console.log(`  Browser ${i + 1} synced peers: ${peers.length}`);
      await Assert.equal(peers.length, 3, `Browser ${i + 1} should have 3 synced peers`);
    }

    // Create a tab on Browser 1, check it propagates to all others
    const testUrl = generateTestUrl('four-peer-propagation');
    await browsers[0].testBridge.createTab(testUrl);
    console.log(`  Created tab on Browser 1: ${testUrl}`);

    await sleep(2000);
    await browsers[0].testBridge.waitForSyncComplete(15000);

    // All browsers should get the tab
    for (let i = 1; i < browsers.length; i++) {
      const deadline = Date.now() + 20000;
      let found = false;
      while (Date.now() < deadline) {
        const tabs = await browsers[i].testBridge.getTabs();
        if (tabs.some(t => t.url && t.url.includes('four-peer-propagation'))) {
          found = true;
          break;
        }
        await sleep(1000);
      }
      console.log(`  Browser ${i + 1} has propagated tab: ${found}`);
      await Assert.isTrue(found, `Tab should propagate to Browser ${i + 1}`);
    }

    results.pass('Four-Peer Mesh');
  } finally {
    for (const b of browsers) {
      await cleanupBrowser(b);
    }
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('MULTI-INSTANCE TESTS (3-Way Mesh)');
  console.log('═'.repeat(60));

  let browserA, browserB, browserC;

  try {
    // Launch three browsers with delays to avoid resource contention
    console.log();
    console.log('Launching three browsers...');
    browserA = await launchBrowser();
    console.log('  Browser A launched');
    await sleep(3000); // Let first browser fully initialize

    browserB = await launchBrowser();
    console.log('  Browser B launched');
    await sleep(3000); // Let second browser fully initialize

    browserC = await launchBrowser();
    console.log('  Browser C launched');
    await sleep(3000); // Let third browser fully initialize

    console.log('✅ All browsers launched');

    // Set up mesh + initial sync
    await testThreeWayConnection(browserA, browserB, browserC);

    console.log();
    console.log('Waiting for initial sync to complete...');
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await browserC.testBridge.waitForSyncComplete(15000);
    await sleep(2000); // Extra time for convergence
    console.log('✅ Initial sync complete');

    // Run tests -- each wrapped so one failure doesn't stop the suite
    const tests = [
      testTabPropagationToAllPeers,
      testSimultaneousChanges,
      testChainPropagation,
      testThreeWayGroupSync,
    ];

    for (const test of tests) {
      try {
        await test(browserA, browserB, browserC);
      } catch (error) {
        results.error(test.name || 'Unknown Test', error);
      }
    }

  } catch (error) {
    results.error('Test Suite Setup', error);
  } finally {
    // Clean up
    console.log();
    console.log('Cleaning up 3-peer browsers...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
    await cleanupBrowser(browserC);
  }

  // 4-peer test manages its own browsers
  try {
    await testFourPeerMesh();
  } catch (error) {
    results.error('Four-Peer Mesh', error);
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

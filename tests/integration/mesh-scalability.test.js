#!/usr/bin/env node
/**
 * Mesh Scalability Tests
 *
 * Parameterized tests for N-peer mesh networking.
 * Default: 5 peers. Override with MESH_SIZE env variable.
 *
 * Covers:
 * - Full mesh formation (every peer connected to every other)
 * - Tab propagation from each peer to all others
 * - Simultaneous tab creation across all peers
 * - Group sync across the mesh
 *
 * Usage:
 *   HEADLESS=1 node tests/run-with-server.js tests/integration/mesh-scalability.test.js
 *   MESH_SIZE=3 HEADLESS=1 node tests/run-with-server.js tests/integration/mesh-scalability.test.js
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const MESH_SIZE = parseInt(process.env.MESH_SIZE) || 5;
const results = new TestResults();

// Timeouts scale with mesh size
const MESH_FORMATION_TIMEOUT = 30000 + (MESH_SIZE * 15000);
const SYNC_PROPAGATION_TIMEOUT = 10000 + (MESH_SIZE * 5000);

/**
 * Launch N browsers with staggered delays so they don't fight for resources.
 */
async function launchMesh(count) {
  const browsers = [];
  for (let i = 0; i < count; i++) {
    const b = await launchBrowser();
    browsers.push(b);
    console.log(`  Browser ${i + 1} launched`);
    if (i < count - 1) {
      await sleep(3000);
    }
  }
  return browsers;
}

/**
 * Wait for full mesh -- every peer has (count - 1) connections and synced peers.
 */
async function waitForFullMesh(browsers) {
  const count = browsers.length;
  const expectedPeers = count - 1;

  // Wait for connections
  console.log(`  Waiting for ${count}-way mesh to form (${expectedPeers} connections each)...`);
  for (let i = 0; i < count; i++) {
    const connected = await browsers[i].testBridge.waitForConnections(expectedPeers, MESH_FORMATION_TIMEOUT);
    if (!connected) {
      const actual = await browsers[i].testBridge.getConnectionCount();
      throw new Error(`Browser ${i + 1} has ${actual}/${expectedPeers} connections after timeout`);
    }
  }

  // Wait for synced peers
  const syncDeadline = Date.now() + MESH_FORMATION_TIMEOUT;
  for (let i = 0; i < count; i++) {
    while (Date.now() < syncDeadline) {
      const peers = await browsers[i].testBridge.getSyncedPeers();
      if (peers.length >= expectedPeers) {
        break;
      }
      console.log(`  Browser ${i + 1}: ${peers.length}/${expectedPeers} synced peers, waiting...`);
      await sleep(2000);
    }
  }
}

// Tests

async function testFullMeshFormation(browsers) {
  console.log();
  console.log(`Test: ${MESH_SIZE}-Peer Full Mesh Formation`);

  const expectedPeers = browsers.length - 1;

  for (let i = 0; i < browsers.length; i++) {
    const peers = await browsers[i].testBridge.getSyncedPeers();
    const conns = await browsers[i].testBridge.getConnectionCount();
    console.log(`  Browser ${i + 1}: ${conns} connections, ${peers.length} synced peers`);
    await Assert.equal(conns, expectedPeers, `Browser ${i + 1} should have ${expectedPeers} connections`);
    await Assert.equal(peers.length, expectedPeers, `Browser ${i + 1} should have ${expectedPeers} synced peers`);
  }

  results.pass(`${MESH_SIZE}-Peer Full Mesh Formation`);
}

async function testTabPropagationFromEachPeer(browsers) {
  console.log();
  console.log(`Test: Tab Propagation From Each Peer`);

  for (let source = 0; source < browsers.length; source++) {
    const tag = `prop-from-${source + 1}`;
    const url = generateTestUrl(tag);
    const tab = await browsers[source].testBridge.createTab(url);
    await browsers[source].testBridge.waitForTabLoad(tab.id);
    console.log(`  Browser ${source + 1} created: ${tag}`);

    await browsers[source].testBridge.waitForSyncComplete(15000);

    // Check all other browsers receive it
    for (let target = 0; target < browsers.length; target++) {
      if (target === source) {
        continue;
      }
      const found = await browsers[target].testBridge.waitForTabUrl(tag, SYNC_PROPAGATION_TIMEOUT);
      await Assert.isTrue(!!found, `Browser ${target + 1} should receive tab from Browser ${source + 1}`);
    }
    console.log(`  All peers received tab from Browser ${source + 1}`);
  }

  results.pass('Tab Propagation From Each Peer');
}

async function testSimultaneousTabCreation(browsers) {
  console.log();
  console.log(`Test: Simultaneous Tab Creation (${MESH_SIZE} peers)`);

  // All browsers create a tab at the same time
  const tags = browsers.map((_, i) => `simultaneous-${i + 1}`);
  const urls = tags.map(tag => generateTestUrl(tag));

  console.log('  Creating tabs simultaneously on all peers...');
  await Promise.all(
    browsers.map((b, i) => b.testBridge.createTab(urls[i]))
  );

  // Wait for convergence
  console.log('  Waiting for convergence...');
  await sleep(3000);
  for (const b of browsers) {
    await b.testBridge.waitForSyncComplete(15000);
  }

  // Extra time for multi-hop propagation
  await sleep(5000);
  for (const b of browsers) {
    await b.testBridge.waitForSyncComplete(15000);
  }

  // Every browser should have every tab
  for (let i = 0; i < browsers.length; i++) {
    const tabs = await browsers[i].testBridge.getTabs();
    const tabUrls = tabs.map(t => t.url || '');
    const missing = [];

    for (let j = 0; j < tags.length; j++) {
      if (!tabUrls.some(u => u.includes(tags[j]))) {
        missing.push(`Browser ${j + 1}'s tab (${tags[j]})`);
      }
    }

    if (missing.length > 0) {
      console.log(`  Browser ${i + 1} missing: ${missing.join(', ')}`);
    }
    await Assert.equal(missing.length, 0, `Browser ${i + 1} should have all ${MESH_SIZE} tabs`);
  }

  console.log(`  All ${MESH_SIZE} peers converged with all tabs`);
  results.pass(`Simultaneous Tab Creation (${MESH_SIZE} peers)`);
}

async function testGroupSyncAcrossMesh(browsers) {
  console.log();
  console.log(`Test: Group Sync Across ${MESH_SIZE}-Peer Mesh`);

  // Create two tabs, group them on Browser 1
  const t1 = await browsers[0].testBridge.createTab(generateTestUrl('mesh-grp-a'));
  await browsers[0].testBridge.waitForTabLoad(t1.id);
  const t2 = await browsers[0].testBridge.createTab(generateTestUrl('mesh-grp-b'));
  await browsers[0].testBridge.waitForTabLoad(t2.id);

  try {
    await browsers[0].testBridge.groupTabs([t1.id, t2.id], 'Mesh Scale Group', 'green');
  } catch (error) {
    if (error.message && error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass(`Group Sync Across ${MESH_SIZE}-Peer Mesh (skipped)`);
      return;
    }
    throw error;
  }

  console.log('  Created group on Browser 1, waiting for propagation...');
  await sleep(1000);
  await browsers[0].testBridge.waitForSyncComplete(15000);

  // Group should appear on all other browsers
  for (let i = 1; i < browsers.length; i++) {
    const found = await browsers[i].testBridge.waitForGroupState('Mesh Scale Group', true, SYNC_PROPAGATION_TIMEOUT);
    await Assert.isTrue(!!found, `Browser ${i + 1} should have "Mesh Scale Group"`);

    const groupInfo = await browsers[i].testBridge.getGroupCount();
    const group = groupInfo.groupDetails.find(g => g.title === 'Mesh Scale Group');
    await Assert.equal(group.tabCount, 2, `Browser ${i + 1} group should have 2 tabs`);
    await Assert.equal(group.color, 'green', `Browser ${i + 1} group should be green`);
    console.log(`  Browser ${i + 1}: group found (${group.tabCount} tabs, ${group.color})`);
  }

  results.pass(`Group Sync Across ${MESH_SIZE}-Peer Mesh`);
}

// Main

async function main() {
  console.log('='.repeat(60));
  console.log(`MESH SCALABILITY TESTS (${MESH_SIZE} peers)`);
  console.log('='.repeat(60));
  console.log(`  Mesh formation timeout: ${MESH_FORMATION_TIMEOUT / 1000}s`);
  console.log(`  Sync propagation timeout: ${SYNC_PROPAGATION_TIMEOUT / 1000}s`);

  let browsers = [];

  try {
    console.log();
    console.log(`Launching ${MESH_SIZE} browsers...`);
    browsers = await launchMesh(MESH_SIZE);
    console.log(`✅ All ${MESH_SIZE} browsers launched`);

    // Set up full mesh
    await waitForFullMesh(browsers);
    console.log('✅ Full mesh established');

    // Let initial sync settle
    for (const b of browsers) {
      await b.testBridge.waitForSyncComplete(15000);
    }
    await sleep(2000);
    console.log('✅ Initial sync complete');

    const tests = [
      () => testFullMeshFormation(browsers),
      () => testTabPropagationFromEachPeer(browsers),
      () => testSimultaneousTabCreation(browsers),
      () => testGroupSyncAcrossMesh(browsers),
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
    console.log(`Cleaning up ${browsers.length} browsers...`);
    for (const b of browsers) {
      await cleanupBrowser(b);
    }
  }

  results.summary();
  process.exit(results.exitCode());
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

main();

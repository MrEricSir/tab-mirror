#!/usr/bin/env node
/**
 * Container Sync Tests
 *
 * Verifies that container (contextual identity) tabs are synced correctly:
 * - Container tabs sync to peer in matching container
 * - Container sync toggle filters/includes container tabs
 * - Missing container on peer falls back to default
 * - Container identity preserved on URL change
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

const CONTAINER_PREFS = {
  'privacy.userContext.enabled': true,
  'privacy.userContext.ui.enabled': true
};

async function testContainerTabSyncsToPeer() {
  console.log();
  console.log('Test: Container tab syncs to peer in matching container');

  let browserA, browserB;

  try {
    console.log('  Launching browsers with container support...');
    browserA = await launchBrowser({ preferences: CONTAINER_PREFS });
    await sleep(1500);

    // Verify containers are available
    const containers = await browserA.testBridge.getContainers();
    if (!containers || containers.length === 0) {
      console.log('  No containers available, skipping');
      results.pass('Container tab syncs to peer (skipped - no containers)');
      return;
    }
    console.log(`  Available containers: ${containers.map(c => c.name).join(', ')}`);

    // Enable container sync
    await browserA.testBridge.setSyncContainerTabs(true);

    // Find the "Personal" container (default Firefox container)
    const personal = containers.find(c => c.name === 'Personal');
    if (!personal) {
      console.log('  No "Personal" container found, skipping');
      results.pass('Container tab syncs to peer (skipped - no Personal container)');
      return;
    }

    // Create a container tab
    const containerUrl = generateTestUrl('container-personal');
    console.log(`  Creating tab in "Personal" container...`);
    const containerTab = await browserA.testBridge.createContainerTab(containerUrl, 'Personal');
    console.log(`  Created tab: cookieStoreId=${containerTab.cookieStoreId}, containerName=${containerTab.containerName}`);
    await sleep(500);

    // Launch B and sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser({ preferences: CONTAINER_PREFS });
    await browserB.testBridge.setSyncContainerTabs(true);

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Find the synced tab on B
    const tabsB = await browserB.testBridge.getTabs();
    const syncedTab = tabsB.find(t => t.url && t.url.includes('container-personal'));
    await Assert.isTrue(!!syncedTab, 'Container tab should appear in Browser B');

    // Verify it's in the Personal container
    const containerInfo = await browserB.testBridge.getTabContainerInfo(syncedTab.id);
    console.log(`  B tab container: name=${containerInfo.containerName}, cookieStoreId=${containerInfo.cookieStoreId}`);
    await Assert.equal(containerInfo.containerName, 'Personal', 'Tab should be in Personal container on B');

    results.pass('Container tab syncs to peer in matching container');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testContainerSyncToggleOff() {
  console.log();
  console.log('Test: Container sync toggle OFF filters container tabs');

  let browserA, browserB;

  try {
    console.log('  Launching browsers...');
    browserA = await launchBrowser({ preferences: CONTAINER_PREFS });
    browserB = await launchBrowser({ preferences: CONTAINER_PREFS });

    // Enable container sync initially on both
    await browserA.testBridge.setSyncContainerTabs(true);
    await browserB.testBridge.setSyncContainerTabs(true);

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);

    // Verify containers available
    const containers = await browserA.testBridge.getContainers();
    if (!containers || containers.length === 0) {
      console.log('  No containers available, skipping');
      results.pass('Container sync toggle OFF (skipped - no containers)');
      return;
    }

    // Create a regular tab and a container tab
    const regularUrl = generateTestUrl('toggle-regular');
    const containerUrl = generateTestUrl('toggle-container');

    await browserA.testBridge.createTab(regularUrl);
    await browserA.testBridge.createContainerTab(containerUrl, 'Personal');
    await sleep(500);

    // Wait for sync
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    await sleep(1000);

    // Both tabs should be on B now
    let tabsB = await browserB.testBridge.getTabs();
    let regularOnB = tabsB.find(t => t.url && t.url.includes('toggle-regular'));
    let containerOnB = tabsB.find(t => t.url && t.url.includes('toggle-container'));
    await Assert.isTrue(!!regularOnB, 'Regular tab should be on B initially');
    await Assert.isTrue(!!containerOnB, 'Container tab should be on B initially');

    // Turn off container sync on A
    console.log('  Disabling container sync on A...');
    await browserA.testBridge.setSyncContainerTabs(false);

    // Wait for sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // B should only have the regular tab now
    tabsB = await browserB.testBridge.getTabs();
    regularOnB = tabsB.find(t => t.url && t.url.includes('toggle-regular'));
    containerOnB = tabsB.find(t => t.url && t.url.includes('toggle-container'));
    console.log(`  B tabs after toggle off: regular=${!!regularOnB}, container=${!!containerOnB}`);
    await Assert.isTrue(!!regularOnB, 'Regular tab should still be on B');
    await Assert.isTrue(!containerOnB, 'Container tab should be removed from B');

    results.pass('Container sync toggle OFF filters container tabs');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testContainerSyncToggleOn() {
  console.log();
  console.log('Test: Container sync toggle ON re-includes container tabs');

  let browserA, browserB;

  try {
    console.log('  Launching browsers...');
    browserA = await launchBrowser({ preferences: CONTAINER_PREFS });
    browserB = await launchBrowser({ preferences: CONTAINER_PREFS });

    // Disable container sync initially
    await browserA.testBridge.setSyncContainerTabs(false);
    await browserB.testBridge.setSyncContainerTabs(true);

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);

    // Verify containers available
    const containers = await browserA.testBridge.getContainers();
    if (!containers || containers.length === 0) {
      console.log('  No containers available, skipping');
      results.pass('Container sync toggle ON (skipped - no containers)');
      return;
    }

    // Create a regular tab and a container tab on A
    const regularUrl = generateTestUrl('reon-regular');
    const containerUrl = generateTestUrl('reon-container');

    await browserA.testBridge.createTab(regularUrl);
    await browserA.testBridge.createContainerTab(containerUrl, 'Personal');
    await sleep(500);

    // Wait for sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Only regular tab should be on B (container sync off on A)
    let tabsB = await browserB.testBridge.getTabs();
    let containerOnB = tabsB.find(t => t.url && t.url.includes('reon-container'));
    console.log(`  B tabs before toggle on: container=${!!containerOnB}`);
    await Assert.isTrue(!containerOnB, 'Container tab should NOT be on B yet');

    // Turn ON container sync on A
    console.log('  Enabling container sync on A...');
    await browserA.testBridge.setSyncContainerTabs(true);

    // Wait for sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Container tab should now appear on B
    tabsB = await browserB.testBridge.getTabs();
    containerOnB = tabsB.find(t => t.url && t.url.includes('reon-container'));
    console.log(`  B tabs after toggle on: container=${!!containerOnB}`);
    await Assert.isTrue(!!containerOnB, 'Container tab should appear on B after enabling sync');

    results.pass('Container sync toggle ON re-includes container tabs');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testContainerMismatchFallsBack() {
  console.log();
  console.log('Test: Container mismatch falls back to default');

  let browserA, browserB;

  try {
    console.log('  Launching browsers...');
    browserA = await launchBrowser({ preferences: CONTAINER_PREFS });
    await sleep(1500);

    // Enable container sync
    await browserA.testBridge.setSyncContainerTabs(true);

    // Verify containers available
    const containers = await browserA.testBridge.getContainers();
    if (!containers || containers.length === 0) {
      console.log('  No containers available, skipping');
      results.pass('Container mismatch fallback (skipped - no containers)');
      return;
    }

    // Create a custom container on A that B won't have
    console.log('  Creating custom container "TestOnlyContainer" on A...');
    const customContainer = await browserA.testBridge.createContainer('TestOnlyContainer', 'pink', 'briefcase');
    console.log(`  Created container: ${customContainer.name} (${customContainer.cookieStoreId})`);

    // Create a tab in the custom container
    const url = generateTestUrl('custom-container');
    const containerTab = await browserA.testBridge.createContainerTab(url, 'TestOnlyContainer');
    console.log(`  Created tab in custom container: ${containerTab.cookieStoreId}`);
    await sleep(500);

    // Launch B (won't have "TestOnlyContainer")
    console.log('  Launching Browser B (without custom container)...');
    browserB = await launchBrowser({ preferences: CONTAINER_PREFS });
    await browserB.testBridge.setSyncContainerTabs(true);

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Find the synced tab on B
    const tabsB = await browserB.testBridge.getTabs();
    const syncedTab = tabsB.find(t => t.url && t.url.includes('custom-container'));
    await Assert.isTrue(!!syncedTab, 'Tab should appear in Browser B');

    // Verify it falls back to default container (since B doesn't have "TestOnlyContainer")
    const containerInfo = await browserB.testBridge.getTabContainerInfo(syncedTab.id);
    console.log(`  B tab container: name=${containerInfo.containerName}, isDefault=${containerInfo.isDefault}`);
    await Assert.isTrue(containerInfo.isDefault, 'Tab should fall back to default container on B');

    results.pass('Container mismatch falls back to default');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testContainerPreservedOnUrlChange() {
  console.log();
  console.log('Test: Container identity preserved on URL change');

  let browserA, browserB;

  try {
    console.log('  Launching browsers...');
    browserA = await launchBrowser({ preferences: CONTAINER_PREFS });
    await sleep(1500);

    // Enable container sync
    await browserA.testBridge.setSyncContainerTabs(true);

    // Verify containers available
    const containers = await browserA.testBridge.getContainers();
    if (!containers || containers.length === 0) {
      console.log('  No containers available, skipping');
      results.pass('Container preserved on URL change (skipped - no containers)');
      return;
    }

    // Create a container tab on A
    const url1 = generateTestUrl('preserve-url1');
    console.log(`  Creating tab in "Personal" container...`);
    const containerTab = await browserA.testBridge.createContainerTab(url1, 'Personal');
    await sleep(500);

    // Launch B and initial sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser({ preferences: CONTAINER_PREFS });
    await browserB.testBridge.setSyncContainerTabs(true);

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify initial sync - tab in Personal container on B
    let tabsB = await browserB.testBridge.getTabs();
    let syncedTab = tabsB.find(t => t.url && t.url.includes('preserve-url1'));
    await Assert.isTrue(!!syncedTab, 'Initial tab should be on B');
    let containerInfo = await browserB.testBridge.getTabContainerInfo(syncedTab.id);
    await Assert.equal(containerInfo.containerName, 'Personal', 'Initial tab should be in Personal container');

    // Navigate the tab on A to a new URL
    const url2 = generateTestUrl('preserve-url2');
    console.log(`  Navigating container tab to new URL...`);
    await browserA.testBridge.updateTab(containerTab.tabId, { url: url2 });
    await sleep(500);

    // Wait for sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify B's tab has the new URL but still in Personal container
    tabsB = await browserB.testBridge.getTabs();
    syncedTab = tabsB.find(t => t.url && t.url.includes('preserve-url2'));
    await Assert.isTrue(!!syncedTab, 'Tab with new URL should be on B');
    containerInfo = await browserB.testBridge.getTabContainerInfo(syncedTab.id);
    console.log(`  B tab after URL change: url contains preserve-url2, container=${containerInfo.containerName}`);
    await Assert.equal(containerInfo.containerName, 'Personal', 'Tab should still be in Personal container after URL change');

    results.pass('Container identity preserved on URL change');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('CONTAINER SYNC TESTS');
  console.log('='.repeat(60));

  const tests = [
    testContainerTabSyncsToPeer,
    testContainerSyncToggleOff,
    testContainerSyncToggleOn,
    testContainerMismatchFallsBack,
    testContainerPreservedOnUrlChange,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      results.error(test.name || 'Unknown Test', error);
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

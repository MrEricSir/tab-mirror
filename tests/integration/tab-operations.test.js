#!/usr/bin/env node
/**
 * Tab Operations Tests
 *
 * Checks advanced tab operations and sync:
 * - Tab ordering (moving tabs up/down)
 * - Tab pinning/unpinning
 * - Tab group creation/deletion
 * - Moving tabs into/out of groups
 * - Exact order and grouping match across browsers
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

/**
 * Get tab order from a browser (returns array of URLs).
 */
async function getTabOrder(testBridge) {
  const tabs = await testBridge.getTabs();
  return tabs
    .filter(t => !t.url.includes('testbridge-init')) // Skip test infrastructure
    .map(t => ({
      id: t.id,
      url: t.url,
      index: t.index,
      pinned: t.pinned || false,
      groupId: t.groupId || null
    }))
    .sort((a, b) => a.index - b.index);
}

/**
 * Check that tab order matches between browsers.
 */
async function verifyTabOrderMatches(browserA, browserB, testName) {
  const orderA = await getTabOrder(browserA.testBridge);
  const orderB = await getTabOrder(browserB.testBridge);

  console.log(`  Browser A order (${orderA.length} tabs):`);
  orderA.forEach((t, i) => console.log(`    ${i}: ${t.url.substring(0, 60)} ${t.pinned ? '[PINNED]' : ''}`));

  console.log(`  Browser B order (${orderB.length} tabs):`);
  orderB.forEach((t, i) => console.log(`    ${i}: ${t.url.substring(0, 60)} ${t.pinned ? '[PINNED]' : ''}`));

  await Assert.equal(orderA.length, orderB.length, `${testName}: Tab counts should match`);

  // Each tab should match (URL, pinned status, and order)
  for (let i = 0; i < orderA.length; i++) {
    await Assert.equal(
      orderA[i].url,
      orderB[i].url,
      `${testName}: Tab at index ${i} URL should match`
    );
    await Assert.equal(
      orderA[i].pinned,
      orderB[i].pinned,
      `${testName}: Tab at index ${i} pinned status should match`
    );
  }
}

async function testTabOrdering(browserA, browserB) {
  console.log();
  console.log('Test: Tab Ordering Sync');

  // Create 3 tabs with distinct URLs for ordering
  console.log('  Creating 3 tabs...');
  const url1 = generateTestUrl('order-1');
  const url2 = generateTestUrl('order-2');
  const url3 = generateTestUrl('order-3');

  const t1 = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(t1.id);
  const t2 = await browserA.testBridge.createTab(url2);
  await browserA.testBridge.waitForTabLoad(t2.id);
  const t3 = await browserA.testBridge.createTab(url3);
  await browserA.testBridge.waitForTabLoad(t3.id);

  // Wait for sync
  console.log('  Waiting for initial sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check initial order matches
  console.log('  Verifying initial order...');
  await verifyTabOrderMatches(browserA, browserB, 'Initial order');

  // Grab last tab, move it to position 0
  console.log('  Moving last tab to front...');
  const orderBeforeMove = await getTabOrder(browserA.testBridge);
  const lastTab = orderBeforeMove[orderBeforeMove.length - 1];
  console.log(`  Moving tab ${lastTab.id} (${lastTab.url.substring(0, 40)}) to index 0`);

  await browserA.testBridge.moveTab(lastTab.id, 0);

  // Wait for sync
  console.log('  Waiting for reorder sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check order matches after move
  console.log('  Verifying order after move...');
  await verifyTabOrderMatches(browserA, browserB, 'After reorder');

  // Last tab should now be first
  const orderAfterMove = await getTabOrder(browserA.testBridge);
  await Assert.isTrue(
    orderAfterMove[0].url.includes('order-3'),
    'Last tab should now be first'
  );

  results.pass('Tab Ordering Sync');
}

async function testTabPinning(browserA, browserB) {
  console.log();
  console.log('Test: Tab Pinning Sync');

  // Grab current tabs
  const orderA = await getTabOrder(browserA.testBridge);
  console.log(`  Starting with ${orderA.length} tabs`);

  if (orderA.length < 2) {
    console.log('  Creating additional tab for pinning test...');
    const pinTab = await browserA.testBridge.createTab(generateTestUrl('pin-test'));
    await browserA.testBridge.waitForTabLoad(pinTab.id);
  }

  // Find first unpinned tab, pin it
  const tabs = await getTabOrder(browserA.testBridge);
  const unpinnedTab = tabs.find(t => !t.pinned);

  if (!unpinnedTab) {
    throw new Error('No unpinned tab found to test pinning');
  }

  console.log(`  Pinning tab ${unpinnedTab.id} in Browser A...`);
  await browserA.testBridge.pinTab(unpinnedTab.id);
  await sleep(1000);

  // Wait for sync
  console.log('  Waiting for pin sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check pinned status matches
  console.log('  Verifying pinned status...');
  await verifyTabOrderMatches(browserA, browserB, 'After pinning');

  // Should have at least one pinned tab
  const orderAfterPin = await getTabOrder(browserA.testBridge);
  const hasPinnedTab = orderAfterPin.some(t => t.pinned);
  await Assert.isTrue(hasPinnedTab, 'Should have at least one pinned tab');

  // Now unpin it
  console.log(`  Unpinning tab ${unpinnedTab.id} in Browser A...`);
  await browserA.testBridge.unpinTab(unpinnedTab.id);
  await sleep(1000);

  // Wait for sync
  console.log('  Waiting for unpin sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check unpinned status matches
  console.log('  Verifying unpinned status...');
  await verifyTabOrderMatches(browserA, browserB, 'After unpinning');

  results.pass('Tab Pinning Sync');
}

async function testTabGroupOperations(browserA, browserB) {
  console.log();
  console.log('Test: Tab Group Operations');

  // Grab baseline grouped tabs (from previous tests)
  const baselineTabs = await getTabOrder(browserA.testBridge);
  const baselineGrouped = baselineTabs.filter(t => t.groupId && t.groupId !== -1).length;

  // Create tabs for grouping
  console.log('  Creating tabs for grouping...');
  const url1 = generateTestUrl('group-1');
  const url2 = generateTestUrl('group-2');

  const grp1 = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(grp1.id);
  const grp2 = await browserA.testBridge.createTab(url2);
  await browserA.testBridge.waitForTabLoad(grp2.id);

  // Grab the tabs we just created
  const tabs = await getTabOrder(browserA.testBridge);
  const groupTab1 = tabs.find(t => t.url.includes('group-1'));
  const groupTab2 = tabs.find(t => t.url.includes('group-2'));

  if (!groupTab1 || !groupTab2) {
    throw new Error('Could not find tabs for grouping');
  }

  // Create a tab group
  console.log(`  Creating tab group with tabs ${groupTab1.id} and ${groupTab2.id}...`);
  try {
    await browserA.testBridge.groupTabs(
      [groupTab1.id, groupTab2.id],
      'Test Group',
      'blue'
    );
    await sleep(1000);

    // Wait for sync
    console.log('  Waiting for group creation sync...');
    await browserA.testBridge.waitForSyncComplete(10000);
    await sleep(2000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Check grouped tabs in both browsers
    const tabsAfterGroupA = await getTabOrder(browserA.testBridge);
    const tabsAfterGroupB = await getTabOrder(browserB.testBridge);

    const groupedA = tabsAfterGroupA.filter(t => t.groupId && t.groupId !== -1);
    const groupedB = tabsAfterGroupB.filter(t => t.groupId && t.groupId !== -1);

    console.log(`  Browser A grouped tabs: ${groupedA.length}`);
    console.log(`  Browser B grouped tabs: ${groupedB.length}`);

    await Assert.equal(groupedA.length, groupedB.length, 'Grouped tab count should match');

    // Ungroup tabs
    console.log('  Ungrouping tabs...');
    await browserA.testBridge.ungroupTabs([groupTab1.id, groupTab2.id]);
    await sleep(1000);

    // Wait for sync
    console.log('  Waiting for ungroup sync...');
    await browserA.testBridge.waitForSyncComplete(10000);
    await sleep(2000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // No grouped tabs should remain
    const finalTabsA = await getTabOrder(browserA.testBridge);
    const finalTabsB = await getTabOrder(browserB.testBridge);

    const finalGroupedA = finalTabsA.filter(t => t.groupId && t.groupId !== -1);
    const finalGroupedB = finalTabsB.filter(t => t.groupId && t.groupId !== -1);

    console.log(`  Final grouped tabs - A: ${finalGroupedA.length}, B: ${finalGroupedB.length} (baseline: ${baselineGrouped})`);
    await Assert.equal(finalGroupedA.length, baselineGrouped, 'Only baseline groups should remain in A');
    await Assert.equal(finalGroupedB.length, baselineGrouped, 'Only baseline groups should remain in B');

    results.pass('Tab Group Operations');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  ⚠️  Tab Groups API not available in this Firefox version');
      console.log('  Skipping group operations test');
      results.pass('Tab Group Operations (skipped - API not available)');
    } else {
      throw error;
    }
  }
}

async function testComplexTabOperations(browserA, browserB) {
  console.log();
  console.log('Test: Complex Tab Operations');

  // Set up a complex scenario
  console.log('  Setting up complex tab scenario...');

  // Create 4 tabs
  const urls = [];
  for (let i = 1; i <= 4; i++) {
    const url = generateTestUrl(`complex-${i}`);
    urls.push(url);
    const tab = await browserA.testBridge.createTab(url);
    await browserA.testBridge.waitForTabLoad(tab.id);
  }

  // Grab the first and fourth tabs
  const tabs = await getTabOrder(browserA.testBridge);
  const firstTab = tabs.find(t => t.url.includes('complex-1'));
  const fourthTab = tabs.find(t => t.url.includes('complex-4'));

  if (!firstTab || !fourthTab) {
    throw new Error('Could not find tabs for complex operations');
  }

  // Pin first tab
  console.log(`  Pinning first tab (${firstTab.id})...`);
  await browserA.testBridge.pinTab(firstTab.id);
  await sleep(500);

  // Move tab 4 to position 1 (right after pinned tab)
  console.log(`  Moving fourth tab (${fourthTab.id}) to position 1...`);
  await browserA.testBridge.moveTab(fourthTab.id, 1);
  await sleep(1000);

  // Let syncs finish
  console.log('  Waiting for complex sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check everything matches
  console.log('  Verifying complex state...');
  await verifyTabOrderMatches(browserA, browserB, 'Complex operations');

  // First tab should be pinned in both
  const orderA = await getTabOrder(browserA.testBridge);
  const orderB = await getTabOrder(browserB.testBridge);

  const firstTabA = orderA.find(t => t.url.includes('complex-1'));
  const firstTabB = orderB.find(t => t.url.includes('complex-1'));

  await Assert.isTrue(firstTabA.pinned, 'First tab should be pinned in A');
  await Assert.isTrue(firstTabB.pinned, 'First tab should be pinned in B');

  results.pass('Complex Tab Operations');
}

async function testOrderPersistenceAcrossChanges(browserA, browserB) {
  console.log();
  console.log('Test: Order Persistence Across Multiple Changes');

  // Grab initial state
  console.log('  Recording initial state...');
  const initialOrder = await getTabOrder(browserA.testBridge);
  console.log(`  Starting with ${initialOrder.length} tabs`);

  // Run multiple operations
  console.log('  Performing sequence of operations...');

  // Add a tab
  const newUrl = generateTestUrl('persistence-test');
  const persistTab = await browserA.testBridge.createTab(newUrl);
  await browserA.testBridge.waitForTabLoad(persistTab.id);

  // Grab the new tab
  const tabs = await getTabOrder(browserA.testBridge);
  const newTab = tabs.find(t => t.url.includes('persistence-test'));

  if (!newTab) {
    throw new Error('New tab not found');
  }

  // Move it to position 0
  console.log(`  Moving new tab (${newTab.id}) to position 0...`);
  await browserA.testBridge.moveTab(newTab.id, 0);
  await sleep(500);

  // Pin it
  console.log(`  Pinning new tab (${newTab.id})...`);
  await browserA.testBridge.pinTab(newTab.id);
  await sleep(1000);

  // Wait for sync
  console.log('  Waiting for sync after multiple operations...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check final state matches
  console.log('  Verifying final state persistence...');
  await verifyTabOrderMatches(browserA, browserB, 'After sequence');

  // New tab should be pinned and near the front
  const finalOrder = await getTabOrder(browserB.testBridge);
  const persistenceTab = finalOrder.find(t => t.url.includes('persistence-test'));
  await Assert.isTrue(!!persistenceTab, 'New tab should exist in Browser B');
  await Assert.isTrue(persistenceTab.pinned, 'New tab should be pinned');

  // Pinned tabs should come before unpinned
  const pinnedTabs = finalOrder.filter(t => t.pinned);
  const firstUnpinnedIdx = finalOrder.findIndex(t => !t.pinned);
  for (const pt of pinnedTabs) {
    await Assert.isTrue(pt.index < firstUnpinnedIdx, 'Pinned tabs should be before unpinned tabs');
  }

  results.pass('Order Persistence Across Multiple Changes');
}

async function testGroupsSurviveReorder(browserA, browserB) {
  console.log();
  console.log('Test: Groups Survive Tab Reorder');

  // Create 3 tabs, group 2 of them
  console.log('  Creating tabs...');
  const url1 = generateTestUrl('gsreorder-1');
  const url2 = generateTestUrl('gsreorder-2');
  const url3 = generateTestUrl('gsreorder-3');

  const ro1 = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(ro1.id);
  const ro2 = await browserA.testBridge.createTab(url2);
  await browserA.testBridge.waitForTabLoad(ro2.id);
  const ro3 = await browserA.testBridge.createTab(url3);
  await browserA.testBridge.waitForTabLoad(ro3.id);

  // Grab the tabs we just created
  let tabs = await getTabOrder(browserA.testBridge);
  const tab1 = tabs.find(t => t.url.includes('gsreorder-1'));
  const tab2 = tabs.find(t => t.url.includes('gsreorder-2'));
  const tab3 = tabs.find(t => t.url.includes('gsreorder-3'));

  if (!tab1 || !tab2 || !tab3) {
    throw new Error('Could not find tabs for group reorder test');
  }

  // Group tabs 1 and 2
  console.log('  Grouping tabs 1 and 2...');
  try {
    await browserA.testBridge.groupTabs([tab1.id, tab2.id], 'Reorder Test', 'green');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  ⚠️  Tab Groups API not available, skipping');
      results.pass('Groups Survive Tab Reorder (skipped - API not available)');
      return;
    }
    throw error;
  }
  await sleep(1000);

  // Wait for sync
  console.log('  Waiting for group sync to Browser B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check our tabs are grouped in B
  let tabsB = await getTabOrder(browserB.testBridge);
  const ourGroupedBefore = tabsB.filter(t => t.url.includes('gsreorder-') && t.groupId && t.groupId !== -1);
  console.log(`  Browser B our grouped tabs before reorder: ${ourGroupedBefore.length}`);
  await Assert.equal(ourGroupedBefore.length, 2, 'Browser B should have our 2 grouped tabs');

  // Move tab3 (ungrouped) to the front, forcing a reorder sync
  console.log('  Moving ungrouped tab to front (triggers reorder on sync)...');
  const tab3InA = (await getTabOrder(browserA.testBridge)).find(t => t.url.includes('gsreorder-3'));
  await browserA.testBridge.moveTab(tab3InA.id, 0);
  await sleep(1000);

  // Wait for sync
  console.log('  Waiting for reorder sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Groups should've survived the reorder in B
  tabsB = await getTabOrder(browserB.testBridge);
  const ourGroupedAfter = tabsB.filter(t => t.url.includes('gsreorder-') && t.groupId && t.groupId !== -1);
  console.log(`  Browser B our grouped tabs after reorder: ${ourGroupedAfter.length}`);

  console.log('  Browser B tab state:');
  tabsB.forEach((t, i) => console.log(`    ${i}: ${t.url.substring(0, 50)} ${t.groupId && t.groupId !== -1 ? '[GROUPED]' : ''}`));

  await Assert.equal(ourGroupedAfter.length, 2, 'Our groups should survive tab reorder (2 grouped tabs)');

  results.pass('Groups Survive Tab Reorder');
}

async function testGroupsSurviveReconnection(browserA, browserB) {
  console.log();
  console.log('Test: Groups Survive Reconnection (simulated restart)');

  // Create tabs, group them
  console.log('  Creating tabs for reconnection test...');
  const url1 = generateTestUrl('gsreconn-1');
  const url2 = generateTestUrl('gsreconn-2');

  const rc1 = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(rc1.id);
  const rc2 = await browserA.testBridge.createTab(url2);
  await browserA.testBridge.waitForTabLoad(rc2.id);

  // Group them
  let tabs = await getTabOrder(browserA.testBridge);
  const grpTab1 = tabs.find(t => t.url.includes('gsreconn-1'));
  const grpTab2 = tabs.find(t => t.url.includes('gsreconn-2'));

  if (!grpTab1 || !grpTab2) {
    throw new Error('Could not find tabs for reconnection test');
  }

  console.log('  Grouping tabs...');
  try {
    await browserA.testBridge.groupTabs([grpTab1.id, grpTab2.id], 'Reconnect Test', 'red');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  ⚠️  Tab Groups API not available, skipping');
      results.pass('Groups Survive Reconnection (skipped - API not available)');
      return;
    }
    throw error;
  }
  await sleep(1000);

  // Wait for initial sync
  console.log('  Waiting for initial sync...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check our tabs are grouped in B
  let tabsB = await getTabOrder(browserB.testBridge);
  const ourGroupedBefore = tabsB.filter(t => t.url.includes('gsreconn-') && t.groupId && t.groupId !== -1);
  const totalGroupedBefore = tabsB.filter(t => t.groupId && t.groupId !== -1).length;
  console.log(`  Browser B grouped tabs before restart: ${totalGroupedBefore} total, ${ourGroupedBefore.length} ours`);
  await Assert.equal(ourGroupedBefore.length, 2, 'Browser B should have our 2 grouped tabs before restart');

  // Restart B (clears in-memory state, keeps syncedPeers)
  console.log('  Simulating restart on Browser B...');
  await browserB.testBridge.simulateRestart();
  await sleep(5000);

  // Trigger sync on A to help B reconnect
  console.log('  Triggering sync on Browser A to aid reconnection...');
  await browserA.testBridge.triggerSync();
  await sleep(2000);

  // Wait for reconnection
  console.log('  Waiting for reconnection...');
  const reconnected = await browserB.testBridge.waitForConnections(1, 45000);
  await Assert.isTrue(reconnected, 'Browser B should reconnect after restart');

  // Wait for sync to stabilize
  console.log('  Waiting for sync after reconnection...');
  await browserA.testBridge.waitForSyncComplete(15000);
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(15000);

  // Extra time for any feedback loops to settle
  await sleep(3000);

  // Groups should've survived the reconnection
  tabsB = await getTabOrder(browserB.testBridge);
  const ourGroupedAfter = tabsB.filter(t => t.url.includes('gsreconn-') && t.groupId && t.groupId !== -1);
  const totalGroupedAfter = tabsB.filter(t => t.groupId && t.groupId !== -1).length;
  console.log(`  Browser B grouped tabs after restart: ${totalGroupedAfter} total, ${ourGroupedAfter.length} ours`);

  console.log('  Browser B tab state after restart:');
  tabsB.forEach((t, i) => console.log(`    ${i}: ${t.url.substring(0, 50)} ${t.groupId && t.groupId !== -1 ? '[GROUPED]' : ''}`));

  // A should still have groups too
  const tabsA = await getTabOrder(browserA.testBridge);
  const ourGroupedA = tabsA.filter(t => t.url.includes('gsreconn-') && t.groupId && t.groupId !== -1);
  const totalGroupedA = tabsA.filter(t => t.groupId && t.groupId !== -1).length;
  console.log(`  Browser A grouped tabs after restart: ${totalGroupedA} total, ${ourGroupedA.length} ours`);

  console.log('  Browser A tab state after restart:');
  tabsA.forEach((t, i) => console.log(`    ${i}: ${t.url.substring(0, 50)} ${t.groupId && t.groupId !== -1 ? '[GROUPED]' : ''}`));

  await Assert.equal(ourGroupedAfter.length, 2, 'Browser B gsreconn groups should survive reconnection');
  await Assert.equal(ourGroupedA.length, 2, 'Browser A gsreconn groups should survive reconnection');

  results.pass('Groups Survive Reconnection');
}

async function testGroupsNotDuplicatedOnReconnect(browserA, browserB) {
  console.log();
  console.log('Test: Groups Not Duplicated on Reconnect');

  // Create tabs, group them on A
  console.log('  Creating tabs for group duplication test...');
  const url1 = generateTestUrl('grpdup-1');
  const url2 = generateTestUrl('grpdup-2');
  const url3 = generateTestUrl('grpdup-3'); // ungrouped, used as control

  const dd1 = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(dd1.id);
  const dd2 = await browserA.testBridge.createTab(url2);
  await browserA.testBridge.waitForTabLoad(dd2.id);
  const dd3 = await browserA.testBridge.createTab(url3);
  await browserA.testBridge.waitForTabLoad(dd3.id);

  // Group tabs 1 and 2
  let tabs = await getTabOrder(browserA.testBridge);
  const grpTab1 = tabs.find(t => t.url.includes('grpdup-1'));
  const grpTab2 = tabs.find(t => t.url.includes('grpdup-2'));

  if (!grpTab1 || !grpTab2) {
    throw new Error('Could not find tabs for group duplication test');
  }

  console.log('  Grouping tabs...');
  try {
    await browserA.testBridge.groupTabs([grpTab1.id, grpTab2.id], 'Dup Test', 'purple');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Groups Not Duplicated on Reconnect (skipped - API not available)');
      return;
    }
    throw error;
  }
  await sleep(1000);

  // Wait for sync to Browser B
  console.log('  Waiting for sync to Browser B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Count distinct groups on both browsers before restart
  let tabsA = await getTabOrder(browserA.testBridge);
  let tabsB = await getTabOrder(browserB.testBridge);
  const totalGroupsA_before = new Set(tabsA.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId)).size;
  const totalGroupsB_before = new Set(tabsB.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId)).size;
  console.log(`  Before restart = A: ${totalGroupsA_before} groups, B: ${totalGroupsB_before} groups`);

  // Restart A (the SOURCE of groups) -- this is the critical scenario.
  // A gets new group sync IDs, B's incremental sync must NOT create duplicate groups.
  console.log('  Simulating restart on Browser A (source)...');
  await browserA.testBridge.simulateRestart();
  await sleep(5000);

  // Nudge reconnection
  console.log('  Triggering sync on Browser B...');
  await browserB.testBridge.triggerSync();
  await sleep(2000);

  const reconnected = await browserA.testBridge.waitForConnections(1, 45000);
  await Assert.isTrue(reconnected, 'Browser A should reconnect after restart');
  await browserA.testBridge.waitForSyncComplete(15000);
  await sleep(3000);
  await browserB.testBridge.waitForSyncComplete(15000);
  await sleep(3000);

  // Count distinct groups on both browsers after A's restart
  tabsA = await getTabOrder(browserA.testBridge);
  tabsB = await getTabOrder(browserB.testBridge);

  const totalGroupsA_after = new Set(tabsA.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId)).size;
  const totalGroupsB_after = new Set(tabsB.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId)).size;

  console.log(`  After A restart = A: ${totalGroupsA_after} groups, B: ${totalGroupsB_after} groups`);

  console.log('  Browser A tab state:');
  tabsA.forEach((t, i) => {
    const marker = t.groupId && t.groupId !== -1 ? `[GROUP ${t.groupId}]` : '';
    console.log(`    ${i}: ${t.url.substring(0, 60)} ${marker}`);
  });

  console.log('  Browser B tab state:');
  tabsB.forEach((t, i) => {
    const marker = t.groupId && t.groupId !== -1 ? `[GROUP ${t.groupId}]` : '';
    console.log(`    ${i}: ${t.url.substring(0, 60)} ${marker}`);
  });

  // Group count should NOT increase after restart
  await Assert.equal(totalGroupsA_after, totalGroupsA_before, 'Browser A should have same number of groups after restart');
  await Assert.equal(totalGroupsB_after, totalGroupsB_before, 'Browser B should have same number of groups after restart (no duplicates)');

  // Our specific test group should be intact
  const grpdupGroupedA = tabsA.filter(t => t.url.includes('grpdup-') && t.groupId && t.groupId !== -1);
  const grpdupGroupedB = tabsB.filter(t => t.url.includes('grpdup-') && t.groupId && t.groupId !== -1);
  await Assert.equal(grpdupGroupedA.length, 2, 'Browser A should have 2 grpdup grouped tabs');
  await Assert.equal(grpdupGroupedB.length, 2, 'Browser B should have 2 grpdup grouped tabs');

  results.pass('Groups Not Duplicated on Reconnect');
}

async function testReplaceLocalStateIdempotent(browserA, browserB) {
  console.log();
  console.log('Test: replaceLocalState Is Idempotent (groups not duplicated)');

  // Both browsers have groups from prior tests.
  // Force replaceLocalState multiple times, check group count never increases.
  const initial = await browserA.testBridge.getGroupCount();
  if (initial.groups === 0) {
    console.log('  No groups to test (Tab Groups API may not be available)');
    results.pass('replaceLocalState Idempotent (skipped - no groups)');
    return;
  }

  console.log(`  Initial state: ${initial.groups} groups, ${initial.groupedTabs} grouped tabs`);
  initial.groupDetails.forEach(g => console.log(`    Group ${g.id}: "${g.title}" (${g.color}) - ${g.tabCount} tabs`));

  // Run replaceLocalState 3 times in a row
  for (let i = 1; i <= 3; i++) {
    console.log(`  Forcing replaceLocalState (iteration ${i})...`);
    const result = await browserA.testBridge.forceReplaceLocalState();
    console.log(`    Tabs: ${result.tabsBefore} → ${result.tabsAfter}, Groups: ${result.groupsBefore} → ${result.groupsAfter}`);

    await Assert.equal(result.groupsAfter, initial.groups,
      `Iteration ${i}: group count should stay at ${initial.groups} (got ${result.groupsAfter})`);
    await Assert.equal(result.tabsAfter, result.tabsBefore,
      `Iteration ${i}: tab count should not change`);
  }

  // Double-check via getGroupCount that nothing drifted
  const final = await browserA.testBridge.getGroupCount();
  console.log(`  Final state: ${final.groups} groups, ${final.groupedTabs} grouped tabs`);
  final.groupDetails.forEach(g => console.log(`    Group ${g.id}: "${g.title}" (${g.color}) - ${g.tabCount} tabs`));

  await Assert.equal(final.groups, initial.groups, 'Total group count should be unchanged');
  await Assert.equal(final.groupedTabs, initial.groupedTabs, 'Grouped tab count should be unchanged');

  // No empty groups should be left over
  const emptyGroups = final.groupDetails.filter(g => g.tabCount === 0);
  await Assert.equal(emptyGroups.length, 0, 'No empty groups should exist');

  results.pass('replaceLocalState Idempotent');
}

async function testGroupsStableAcrossMultipleRestarts(browserA, browserB) {
  console.log();
  console.log('Test: Groups Stable Across Multiple Restarts');

  // Grab baseline group count from both browsers
  const baselineA = await browserA.testBridge.getGroupCount();
  const baselineB = await browserB.testBridge.getGroupCount();

  if (baselineA.groups === 0) {
    console.log('  No groups to test (Tab Groups API may not be available)');
    results.pass('Groups Stable Across Multiple Restarts (skipped - no groups)');
    return;
  }

  console.log(`  Baseline = A: ${baselineA.groups} groups (${baselineA.groupedTabs} tabs), B: ${baselineB.groups} groups (${baselineB.groupedTabs} tabs)`);

  // Cycle: restart A, sync, restart B, sync, restart A, sync
  const restartSequence = ['A', 'B', 'A'];
  for (const who of restartSequence) {
    const target = who === 'A' ? browserA : browserB;
    const helper = who === 'A' ? browserB : browserA;

    console.log(`  Restarting Browser ${who}...`);
    await target.testBridge.simulateRestart();
    await sleep(5000);

    console.log(`  Triggering sync on Browser ${who === 'A' ? 'B' : 'A'}...`);
    await helper.testBridge.triggerSync();
    await sleep(2000);

    const reconnected = await target.testBridge.waitForConnections(1, 45000);
    await Assert.isTrue(reconnected, `Browser ${who} should reconnect`);
    await browserA.testBridge.waitForSyncComplete(15000);
    await sleep(3000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(2000);

    const afterA = await browserA.testBridge.getGroupCount();
    const afterB = await browserB.testBridge.getGroupCount();

    console.log(`  After ${who} restart = A: ${afterA.groups} groups (${afterA.groupedTabs} tabs), B: ${afterB.groups} groups (${afterB.groupedTabs} tabs)`);

    await Assert.equal(afterA.groups, baselineA.groups,
      `After ${who} restart: Browser A group count should stay at ${baselineA.groups} (got ${afterA.groups})`);
    await Assert.equal(afterB.groups, baselineB.groups,
      `After ${who} restart: Browser B group count should stay at ${baselineB.groups} (got ${afterB.groups})`);

    // No empty groups allowed
    const emptyA = afterA.groupDetails.filter(g => g.tabCount === 0);
    const emptyB = afterB.groupDetails.filter(g => g.tabCount === 0);
    await Assert.equal(emptyA.length, 0, `After ${who} restart: Browser A should have no empty groups`);
    await Assert.equal(emptyB.length, 0, `After ${who} restart: Browser B should have no empty groups`);
  }

  results.pass('Groups Stable Across Multiple Restarts');
}

async function testPrivilegedTabOrdering(browserA, browserB) {
  console.log();
  console.log('Test: Privileged Tab Doesn\'t Disrupt Ordering');

  // Create tabs A, B, C
  const urlA = generateTestUrl('priv-order-a');
  const urlB = generateTestUrl('priv-order-b');
  const urlC = generateTestUrl('priv-order-c');

  const privA = await browserA.testBridge.createTab(urlA);
  await browserA.testBridge.waitForTabLoad(privA.id);
  const privB = await browserA.testBridge.createTab(urlB);
  await browserA.testBridge.waitForTabLoad(privB.id);
  const privC = await browserA.testBridge.createTab(urlC);
  await browserA.testBridge.waitForTabLoad(privC.id);

  // Create a privileged tab (testbridge-init URLs count as privileged)
  const privUrl = generateTestUrl('testbridge-init-middle');
  const privTab = await browserA.testBridge.createTab(privUrl);
  console.log(`  Created privileged tab: ${privUrl} (id: ${privTab.id})`);

  // Move privileged tab between B and C
  const tabsBeforeMove = await browserA.testBridge.getTabs();
  const tabB = tabsBeforeMove.find(t => t.url && t.url.includes('priv-order-b'));
  const tabC = tabsBeforeMove.find(t => t.url && t.url.includes('priv-order-c'));
  console.log(`  Tab B index: ${tabB.index}, Tab C index: ${tabC.index}`);
  await browserA.testBridge.moveTab(privTab.id, tabC.index);
  console.log(`  Moved privileged tab to index ${tabC.index} (between B and C)`);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // B should NOT have the privileged tab
  const tabsB = await browserB.testBridge.getTabs();
  const hasPriv = tabsB.some(t => t.url && t.url.includes('testbridge-init-middle'));
  await Assert.isTrue(!hasPriv, 'Browser B should not have the privileged tab');

  // Create tab D at the end in A
  const urlD = generateTestUrl('priv-order-d');
  await browserA.testBridge.createTab(urlD);
  console.log(`  Created tab D after privileged tab: ${urlD}`);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check tab D synced to B
  const tabsBAfter = await browserB.testBridge.getTabs();
  const hasDinB = tabsBAfter.some(t => t.url && t.url.includes('priv-order-d'));
  await Assert.isTrue(hasDinB, 'Browser B should have tab D');

  // Tab D should still be after the privileged tab in A
  const tabsAAfter = await browserA.testBridge.getTabs();
  const privTabAfter = tabsAAfter.find(t => t.url && t.url.includes('testbridge-init-middle'));
  const tabDAfter = tabsAAfter.find(t => t.url && t.url.includes('priv-order-d'));
  console.log(`  Privileged tab index: ${privTabAfter.index}, Tab D index: ${tabDAfter.index}`);
  await Assert.isTrue(tabDAfter.index > privTabAfter.index, 'Tab D should remain after privileged tab');

  results.pass('Privileged Tab Doesn\'t Disrupt Ordering');
}

async function testNavigateToPrivilegedUrl(browserA, browserB) {
  console.log();
  console.log('Test: Navigating to Privileged URL Doesn\'t Close Tab');

  // Start with a normal tab
  const normalUrl = generateTestUrl('will-go-priv');
  const tab = await browserA.testBridge.createTab(normalUrl);
  console.log(`  Created tab: ${normalUrl} (id: ${tab.id})`);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check it synced to B
  let tabsB = await browserB.testBridge.getTabs();
  const hasBefore = tabsB.some(t => t.url && t.url.includes('will-go-priv'));
  await Assert.isTrue(hasBefore, 'Browser B should have the tab before navigation');

  // Navigate tab to a privileged URL
  const privUrl = generateTestUrl('testbridge-init-navigated');
  console.log(`  Navigating tab to privileged URL: ${privUrl}`);
  await browserA.testBridge.updateTab(tab.id, { url: privUrl });

  // Let multiple sync cycles run
  await sleep(5000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(3000);

  // Tab should still exist in A
  const tabsAAfter = await browserA.testBridge.getTabs();
  const stillExists = tabsAAfter.some(t => t.id === tab.id);
  await Assert.isTrue(stillExists, 'Tab should still exist in Browser A after navigating to privileged URL');
  console.log(`  Tab still exists: ${stillExists}`);

  // Tab should be gone from B (remote correctly removes its copy)
  // but should NOT be closed locally in A

  results.pass('Navigating to Privileged URL Doesn\'t Close Tab');
}

async function testUnpairRemovesDevice(browserA, browserB) {
  console.log();
  console.log('Test: Unpair Removes Device From Paired List');

  // Grab peer IDs for both browsers
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();
  const peerIdA = stateA.myDeviceId;
  const peerIdB = stateB.myDeviceId;
  console.log(`  Browser A: ${peerIdA}`);
  console.log(`  Browser B: ${peerIdB}`);

  // Add B as a paired device on A
  await browserA.testBridge.addPairedDevice(peerIdB, 'Test Device B');
  const devicesAfterAdd = await browserA.testBridge.getPairedDevices();
  console.log(`  Paired devices after add: ${devicesAfterAdd.length}`);
  await Assert.isTrue(devicesAfterAdd.length >= 1, 'Should have at least 1 paired device after adding');

  const addedDevice = devicesAfterAdd.find(d => d.peerId === peerIdB);
  await Assert.isTrue(!!addedDevice, 'Paired list should contain Browser B');
  console.log(`  Device B connected: ${addedDevice.connected}`);

  // Unpair B
  await browserA.testBridge.unpairDevice(peerIdB);
  const devicesAfterUnpair = await browserA.testBridge.getPairedDevices();
  console.log(`  Paired devices after unpair: ${devicesAfterUnpair.length}`);

  const removedDevice = devicesAfterUnpair.find(d => d.peerId === peerIdB);
  await Assert.isTrue(!removedDevice, 'Paired list should NOT contain Browser B after unpairing');

  // Add and remove multiple devices to check list management
  await browserA.testBridge.addPairedDevice('fake-peer-1', 'Fake Device 1');
  await browserA.testBridge.addPairedDevice('fake-peer-2', 'Fake Device 2');
  const devicesWithFakes = await browserA.testBridge.getPairedDevices();
  await Assert.isTrue(devicesWithFakes.length >= 2, 'Should have at least 2 devices');

  // Fake devices should show as disconnected
  const fake1 = devicesWithFakes.find(d => d.peerId === 'fake-peer-1');
  await Assert.isTrue(!!fake1, 'Should have fake-peer-1');
  await Assert.isTrue(!fake1.connected, 'Fake peer should not be connected');

  // Remove one fake, check the other stays
  await browserA.testBridge.unpairDevice('fake-peer-1');
  const devicesAfterPartial = await browserA.testBridge.getPairedDevices();
  await Assert.isTrue(!devicesAfterPartial.find(d => d.peerId === 'fake-peer-1'), 'fake-peer-1 should be removed');
  await Assert.isTrue(!!devicesAfterPartial.find(d => d.peerId === 'fake-peer-2'), 'fake-peer-2 should still exist');

  // Clean up last fake
  await browserA.testBridge.unpairDevice('fake-peer-2');
  const devicesClean = await browserA.testBridge.getPairedDevices();
  await Assert.isTrue(!devicesClean.find(d => d.peerId === 'fake-peer-2'), 'fake-peer-2 should be removed');

  // Restore connection, unpairDevice closes the PeerJS connection
  await browserA.testBridge.simulateRestart();
  await browserA.testBridge.waitForConnections(1, 15000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  results.pass('Unpair Removes Device From Paired List');
}

async function testGroupRemovalSync(browserA, browserB) {
  console.log();
  console.log('Test: Group Removal Syncs to Other Browser');

  // Create 2 tabs, group them on A
  const url1 = generateTestUrl('grm-1');
  const url2 = generateTestUrl('grm-2');
  const t1 = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(t1.id);
  const t2 = await browserA.testBridge.createTab(url2);
  await browserA.testBridge.waitForTabLoad(t2.id);

  try {
    await browserA.testBridge.groupTabs([t1.id, t2.id], 'Remove Me', 'orange');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Group Removal Sync (skipped)');
      return;
    }
    throw error;
  }
  await sleep(1000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Group should show up on B
  const groupOnB = await browserB.testBridge.waitForGroupState('Remove Me', true);
  console.log(`  B has Remove Me group: ${!!groupOnB}`);
  await Assert.isTrue(!!groupOnB, 'B should have "Remove Me" group');

  // Remove group on A
  console.log('  Removing group on Browser A...');
  await browserA.testBridge.ungroupTabs([t1.id, t2.id]);
  await sleep(1000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Group should disappear on B
  const groupGone = await browserB.testBridge.waitForGroupState('Remove Me', false);
  console.log(`  B Remove Me group gone: ${groupGone}`);
  await Assert.isTrue(groupGone, 'B should no longer have "Remove Me" group');

  results.pass('Group Removal Sync');
}

async function testSimultaneousGroupCreation(browserA, browserB) {
  console.log();
  console.log('Test: Simultaneous Group Creation (pure incremental)');

  // Create tabs on both sides
  const a1 = await browserA.testBridge.createTab(generateTestUrl('simgrp-a1'));
  const a2 = await browserA.testBridge.createTab(generateTestUrl('simgrp-a2'));
  const b1 = await browserB.testBridge.createTab(generateTestUrl('simgrp-b1'));
  const b2 = await browserB.testBridge.createTab(generateTestUrl('simgrp-b2'));
  await Promise.all([
    browserA.testBridge.waitForTabLoad(a2.id),
    browserB.testBridge.waitForTabLoad(b2.id),
  ]);

  // Wait for tabs to sync
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Create groups on both at the same time
  console.log('  Creating groups on both browsers simultaneously...');
  try {
    await Promise.all([
      browserA.testBridge.groupTabs([a1.id, a2.id], 'Alpha Group', 'cyan'),
      browserB.testBridge.groupTabs([b1.id, b2.id], 'Beta Group', 'yellow')
    ]);
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Simultaneous Group Creation (skipped)');
      return;
    }
    throw error;
  }

  // Wait for sync to settle
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Both browsers should have both groups
  const groupsA = await browserA.testBridge.getGroupCount();
  const groupsB = await browserB.testBridge.getGroupCount();

  const aNamesSet = new Set(groupsA.groupDetails.map(g => g.title));
  const bNamesSet = new Set(groupsB.groupDetails.map(g => g.title));
  console.log(`  A groups: ${[...aNamesSet].join(', ')}`);
  console.log(`  B groups: ${[...bNamesSet].join(', ')}`);

  await Assert.isTrue(aNamesSet.has('Alpha Group'), 'A should have Alpha Group');
  await Assert.isTrue(aNamesSet.has('Beta Group'), 'A should have Beta Group');
  await Assert.isTrue(bNamesSet.has('Alpha Group'), 'B should have Alpha Group');
  await Assert.isTrue(bNamesSet.has('Beta Group'), 'B should have Beta Group');

  // Each group should have exactly 2 tabs
  const alphaA = groupsA.groupDetails.find(g => g.title === 'Alpha Group');
  const betaA = groupsA.groupDetails.find(g => g.title === 'Beta Group');
  await Assert.equal(alphaA.tabCount, 2, 'Alpha Group on A should have 2 tabs');
  await Assert.equal(betaA.tabCount, 2, 'Beta Group on A should have 2 tabs');

  // Clean up
  await browserA.testBridge.ungroupTabs([a1.id, a2.id]);
  const tabsB = await getTabOrder(browserB.testBridge);
  const b1InB = tabsB.find(t => t.url.includes('simgrp-b1'));
  const b2InB = tabsB.find(t => t.url.includes('simgrp-b2'));
  if (b1InB && b2InB) {
    await browserB.testBridge.ungroupTabs([b1InB.id, b2InB.id]);
  }
  await sleep(1000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  results.pass('Simultaneous Group Creation');
}

async function testGroupColorTitleSync(browserA, browserB) {
  console.log();
  console.log('Test: Group Color & Title Sync');

  // Create tabs, group them
  const t1 = await browserA.testBridge.createTab(generateTestUrl('gcolor-1'));
  await browserA.testBridge.waitForTabLoad(t1.id);
  const t2 = await browserA.testBridge.createTab(generateTestUrl('gcolor-2'));
  await browserA.testBridge.waitForTabLoad(t2.id);

  try {
    await browserA.testBridge.groupTabs([t1.id, t2.id], 'Original Title', 'blue');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Group Color & Title Sync (skipped)');
      return;
    }
    throw error;
  }
  await sleep(1000);

  // Group should appear on B
  const originalOnB = await browserB.testBridge.waitForGroupState('Original Title', true);
  console.log(`  B has Original Title: ${!!originalOnB}, color: ${originalOnB ? originalOnB.color : 'N/A'}`);
  await Assert.isTrue(!!originalOnB, 'B should have "Original Title" group');
  await Assert.equal(originalOnB.color, 'blue', 'B should have blue group');

  // Rename and recolor on A by re-grouping
  const tabsA = await getTabOrder(browserA.testBridge);
  const gTab1 = tabsA.find(t => t.url.includes('gcolor-1'));
  console.log(`  Renaming group on A to "Renamed Title" (red)...`);
  await browserA.testBridge.groupTabs([gTab1.id], 'Renamed Title', 'red', gTab1.groupId);
  await sleep(1000);

  // Force broadcast; tabGroups.onUpdated may not fire cross-extension
  await browserA.testBridge.triggerSync();
  await sleep(2000);

  // Renamed group should appear on B
  const renamedOnB = await browserB.testBridge.waitForGroupState('Renamed Title', true);
  console.log(`  B has Renamed Title: ${!!renamedOnB}, color: ${renamedOnB ? renamedOnB.color : 'N/A'}`);
  await Assert.isTrue(!!renamedOnB, 'B should have "Renamed Title" group');
  await Assert.equal(renamedOnB.color, 'red', 'B group should now be red');

  // Clean up
  await browserA.testBridge.ungroupTabs([t1.id, t2.id]);
  await sleep(1000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  results.pass('Group Color & Title Sync');
}

async function testRapidGroupOperations(browserA, browserB) {
  console.log();
  console.log('Test: Rapid Group Operations');

  // Create 4 tabs
  const t1 = await browserA.testBridge.createTab(generateTestUrl('rapid-1'));
  const t2 = await browserA.testBridge.createTab(generateTestUrl('rapid-2'));
  const t3 = await browserA.testBridge.createTab(generateTestUrl('rapid-3'));
  const t4 = await browserA.testBridge.createTab(generateTestUrl('rapid-4'));
  await browserA.testBridge.waitForTabLoad(t4.id);

  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Rapid sequence: group 1+2, add 3, remove 2, rename
  console.log('  Performing rapid group operations...');
  try {
    // Group 1 and 2
    await browserA.testBridge.groupTabs([t1.id, t2.id], 'Rapid Group', 'green');
    await sleep(200);

    // Add 3 to the group
    let tabsA = await getTabOrder(browserA.testBridge);
    const tab1 = tabsA.find(t => t.url.includes('rapid-1'));
    await browserA.testBridge.groupTabs([t3.id], 'Rapid Group', 'green', tab1.groupId);
    await sleep(200);

    // Pull 2 out of the group
    await browserA.testBridge.ungroupTabs([t2.id]);
    await sleep(200);

    // Rename
    await browserA.testBridge.groupTabs([t1.id], 'Final Name', 'purple', tab1.groupId);
    await sleep(200);
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Rapid Group Operations (skipped)');
      return;
    }
    throw error;
  }

  // Let everything sync
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // B should've converged with "Final Name" containing tabs 1 and 3
  const groupsB = await browserB.testBridge.getGroupCount();
  const finalB = groupsB.groupDetails.find(g => g.title === 'Final Name');
  console.log(`  B groups: ${groupsB.groupDetails.map(g => `${g.title}(${g.tabCount})`).join(', ')}`);
  await Assert.isTrue(!!finalB, 'B should have "Final Name" group');
  await Assert.equal(finalB.tabCount, 2, 'Final Name should have 2 tabs (rapid-1 and rapid-3)');

  // rapid-2 should NOT be grouped
  const tabsBOrder = await getTabOrder(browserB.testBridge);
  const rapid2 = tabsBOrder.find(t => t.url.includes('rapid-2'));
  await Assert.isTrue(!rapid2.groupId || rapid2.groupId === -1, 'rapid-2 should not be grouped');

  // Clean up
  await browserA.testBridge.ungroupTabs([t1.id, t3.id]);
  await sleep(1000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  results.pass('Rapid Group Operations');
}

async function testClosingLastTabInGroup(browserA, browserB) {
  console.log();
  console.log('Test: Closing Last Tab in Group');

  // Create tabs, group them
  const t1 = await browserA.testBridge.createTab(generateTestUrl('lastgrp-1'));
  await browserA.testBridge.waitForTabLoad(t1.id);
  const t2 = await browserA.testBridge.createTab(generateTestUrl('lastgrp-2'));
  await browserA.testBridge.waitForTabLoad(t2.id);

  try {
    await browserA.testBridge.groupTabs([t1.id, t2.id], 'Doomed Group', 'red');
  } catch (error) {
    if (error.message.includes('Tab Groups API not available')) {
      console.log('  Skipping - Tab Groups API not available');
      results.pass('Closing Last Tab in Group (skipped)');
      return;
    }
    throw error;
  }
  await sleep(1000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Doomed Group should appear on B
  const doomedOnB = await browserB.testBridge.waitForGroupState('Doomed Group', true);
  console.log(`  B has Doomed Group: ${!!doomedOnB}`);
  await Assert.isTrue(!!doomedOnB, 'B should have Doomed Group');

  // Close both tabs in A (kills the group)
  console.log('  Closing both tabs in the group...');
  await browserA.testBridge.closeTab(t1.id);
  await sleep(300);
  await browserA.testBridge.closeTab(t2.id);
  await sleep(1000);

  // Force broadcast: tab events may not fire cross-extension on Linux
  await browserA.testBridge.triggerSync();
  await sleep(2000);

  // Group should disappear on B
  const doomedGone = await browserB.testBridge.waitForGroupState('Doomed Group', false);
  // Let sync settle for tab cleanup
  await browserB.testBridge.waitForSyncComplete(10000);

  // B should have neither the tabs nor the group
  const tabsBAfter = await getTabOrder(browserB.testBridge);
  const lastgrpTabs = tabsBAfter.filter(t => t.url.includes('lastgrp-'));
  console.log(`  B lastgrp tabs remaining: ${lastgrpTabs.length}`);
  console.log(`  B Doomed Group gone: ${doomedGone}`);

  await Assert.equal(lastgrpTabs.length, 0, 'B should have no lastgrp tabs');
  await Assert.isTrue(doomedGone, 'B should not have Doomed Group anymore');

  results.pass('Closing Last Tab in Group');
}

async function testPairingFlow(browserA, browserB) {
  console.log();
  console.log('Test: Pairing Flow (startPairing + joinPairing)');

  // Start pairing on Browser A
  console.log('  Starting pairing on Browser A...');
  const startResult = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  console.log(`  Pairing code: ${startResult.code}, status: ${startResult.status}`);
  await Assert.isTrue(!!startResult.code, 'Should get a pairing code');

  // Join pairing on Browser B using the code
  console.log(`  Joining pairing on Browser B with code ${startResult.code}...`);
  const joinResult = await browserB.testBridge._sendToTabMirror({ action: 'joinPairing', code: startResult.code });
  console.log(`  Join result: ${JSON.stringify(joinResult)}`);

  // Wait for exchange to complete
  await sleep(5000);

  // Check pairing status on both
  const statusA = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  const statusB = await browserB.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  A pairing status: ${statusA ? statusA.status : 'null'}`);
  console.log(`  B pairing status: ${statusB ? statusB.status : 'null'}`);

  // Both should have each other as paired devices
  const devicesA = await browserA.testBridge.getPairedDevices();
  const devicesB = await browserB.testBridge.getPairedDevices();
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  console.log(`  A paired devices: ${devicesA.map(d => d.peerId).join(', ')}`);
  console.log(`  B paired devices: ${devicesB.map(d => d.peerId).join(', ')}`);

  const aHasB = devicesA.some(d => d.peerId === stateB.myDeviceId);
  const bHasA = devicesB.some(d => d.peerId === stateA.myDeviceId);

  await Assert.isTrue(aHasB, 'A should have B as a paired device');
  await Assert.isTrue(bHasA, 'B should have A as a paired device');

  // Clean up paired devices
  await browserA.testBridge.unpairDevice(stateB.myDeviceId);
  await browserB.testBridge.unpairDevice(stateA.myDeviceId);

  results.pass('Pairing Flow');
}

async function testPairingCancel(browserA, browserB) {
  console.log();
  console.log('Test: Pairing Cancel');

  // Start pairing on A
  console.log('  Starting pairing on Browser A...');
  const startResult = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  console.log(`  Pairing code: ${startResult.code}, status: ${startResult.status}`);
  await Assert.isTrue(!!startResult.code, 'Should get a pairing code');

  // Check status is 'waiting'
  const statusWaiting = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  Status after start: ${statusWaiting.status}`);
  await Assert.equal(statusWaiting.status, 'waiting', 'Status should be waiting after startPairing');

  // Cancel pairing
  console.log('  Cancelling pairing...');
  await browserA.testBridge._sendToTabMirror({ action: 'cancelPairing' });

  // Status should go back to 'none'
  const statusAfterCancel = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  Status after cancel: ${statusAfterCancel.status}`);
  await Assert.equal(statusAfterCancel.status, 'none', 'Status should be none after cancel');

  // Should be able to start a new pairing (temp peer was cleaned up)
  console.log('  Starting new pairing to verify cleanup...');
  const newStart = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  console.log(`  New pairing code: ${newStart.code}`);
  await Assert.isTrue(!!newStart.code, 'Should get a new pairing code after cancel');
  await Assert.isTrue(newStart.code !== startResult.code, 'New code should differ from cancelled code');

  // Clean up
  await browserA.testBridge._sendToTabMirror({ action: 'cancelPairing' });

  results.pass('Pairing Cancel');
}

async function testPairingStatusTransitions(browserA, browserB) {
  console.log();
  console.log('Test: Pairing Status Transitions (none → waiting → success)');

  // Initial status should be 'none'
  const initialStatus = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  Initial status A: ${initialStatus.status}`);
  await Assert.equal(initialStatus.status, 'none', 'Initial status should be none');

  // Start pairing on A, should be 'waiting'
  console.log('  Starting pairing on A...');
  const startResult = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  const waitingStatus = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  Status after start: ${waitingStatus.status}, code: ${startResult.code}`);
  await Assert.equal(waitingStatus.status, 'waiting', 'Status should be waiting');

  // Join on B, poll both until 'success'
  console.log('  Joining from B...');
  await browserB.testBridge._sendToTabMirror({ action: 'joinPairing', code: startResult.code });

  // Poll for success on both sides
  const deadline = Date.now() + 15000;
  let statusA, statusB;
  while (Date.now() < deadline) {
    statusA = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
    statusB = await browserB.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
    if (statusA.status === 'success' && statusB.status === 'success') {
      break;
    }
    console.log(`  A: ${statusA.status}, B: ${statusB.status}`);
    await sleep(1000);
  }
  console.log(`  Final - A: ${statusA.status}, B: ${statusB.status}`);
  await Assert.equal(statusA.status, 'success', 'A should reach success');
  await Assert.equal(statusB.status, 'success', 'B should reach success');

  // Clean up: unpair both
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();
  await browserA.testBridge.unpairDevice(stateB.myDeviceId);
  await browserB.testBridge.unpairDevice(stateA.myDeviceId);

  results.pass('Pairing Status Transitions');
}

async function testInvalidPairingCode(browserA, browserB) {
  console.log();
  console.log('Test: Invalid Pairing Code');

  // Start pairing on A (gets code)
  const startResult = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  console.log(`  A pairing code: ${startResult.code}`);

  // Join on B with wrong code
  console.log('  Joining on B with invalid code ZZZZ-ZZZZ...');
  await browserB.testBridge._sendToTabMirror({ action: 'joinPairing', code: 'ZZZZ-ZZZZ' });

  // Wait a few seconds -- B should NOT reach 'success'
  await sleep(3000);

  const statusB = await browserB.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  B status after wrong code: ${statusB.status}`);
  await Assert.isTrue(statusB.status !== 'success', 'B should NOT succeed with wrong code');

  // A should still be waiting (nobody joined correctly)
  const statusA = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
  console.log(`  A status: ${statusA.status}`);
  await Assert.equal(statusA.status, 'waiting', 'A should still be waiting');

  // Clean up both sides
  await browserA.testBridge._sendToTabMirror({ action: 'cancelPairing' });
  await browserB.testBridge._sendToTabMirror({ action: 'cancelPairing' });

  results.pass('Invalid Pairing Code');
}

async function testMultiplePairedDevices(browserA, browserB) {
  console.log();
  console.log('Test: Multiple Paired Devices Management');

  // Clean any existing paired devices
  const existing = await browserA.testBridge.getPairedDevices();
  for (const d of existing) {
    await browserA.testBridge.unpairDevice(d.peerId);
  }

  // Add 3 fake devices
  await browserA.testBridge.addPairedDevice('device-alpha', 'Alpha Device');
  await browserA.testBridge.addPairedDevice('device-beta', 'Beta Device');
  await browserA.testBridge.addPairedDevice('device-gamma', 'Gamma Device');

  const devicesAfterAdd = await browserA.testBridge.getPairedDevices();
  console.log(`  Devices after adding 3: ${devicesAfterAdd.length}`);
  await Assert.equal(devicesAfterAdd.length, 3, 'Should have 3 paired devices');

  // All 3 should be present
  await Assert.isTrue(!!devicesAfterAdd.find(d => d.peerId === 'device-alpha'), 'Alpha should be present');
  await Assert.isTrue(!!devicesAfterAdd.find(d => d.peerId === 'device-beta'), 'Beta should be present');
  await Assert.isTrue(!!devicesAfterAdd.find(d => d.peerId === 'device-gamma'), 'Gamma should be present');

  // Remove middle one
  await browserA.testBridge.unpairDevice('device-beta');
  const devicesAfterRemove = await browserA.testBridge.getPairedDevices();
  console.log(`  Devices after removing Beta: ${devicesAfterRemove.length}`);
  await Assert.equal(devicesAfterRemove.length, 2, 'Should have 2 after removing Beta');
  await Assert.isTrue(!!devicesAfterRemove.find(d => d.peerId === 'device-alpha'), 'Alpha should remain');
  await Assert.isTrue(!devicesAfterRemove.find(d => d.peerId === 'device-beta'), 'Beta should be gone');
  await Assert.isTrue(!!devicesAfterRemove.find(d => d.peerId === 'device-gamma'), 'Gamma should remain');

  // Re-add Beta
  await browserA.testBridge.addPairedDevice('device-beta', 'Beta Device v2');
  const devicesAfterReadd = await browserA.testBridge.getPairedDevices();
  console.log(`  Devices after re-adding Beta: ${devicesAfterReadd.length}`);
  await Assert.equal(devicesAfterReadd.length, 3, 'Should have 3 again');

  // Clean up all
  await browserA.testBridge.unpairDevice('device-alpha');
  await browserA.testBridge.unpairDevice('device-beta');
  await browserA.testBridge.unpairDevice('device-gamma');
  const devicesClean = await browserA.testBridge.getPairedDevices();
  await Assert.equal(devicesClean.length, 0, 'Should have 0 after cleanup');

  results.pass('Multiple Paired Devices Management');
}

async function testHMACCryptoFunctions(browserA, browserB) {
  console.log();
  console.log('Test: HMAC Crypto Functions');

  // Call testHMAC handler -- _sendToTabMirror unwraps { success, data }, returns data directly
  const result = await browserA.testBridge._sendToTabMirror({ action: 'testHMAC', nonce: 'test-nonce-fixed' });
  console.log(`  HMAC result: ${JSON.stringify(result)}`);

  await Assert.isTrue(!!result, 'testHMAC should return data');

  // HMAC should be a 64-char hex string (SHA-256, 32 bytes, 64 hex chars)
  const hmac = result.hmac;
  console.log(`  HMAC: ${hmac}`);
  await Assert.equal(hmac.length, 64, 'HMAC should be 64-char hex string');
  await Assert.isTrue(/^[0-9a-f]{64}$/.test(hmac), 'HMAC should be lowercase hex');

  // Same key + same nonce should be valid
  await Assert.isTrue(result.valid === true, 'Same key + same nonce should verify');

  // Same key + wrong nonce should be invalid
  await Assert.isTrue(result.invalidMsg === false, 'Same key + wrong nonce should NOT verify');

  // Different key + same nonce should be invalid
  await Assert.isTrue(result.invalidKey === false, 'Different key + same nonce should NOT verify');

  results.pass('HMAC Crypto Functions');
}

async function testPairedDeviceConnectionStatus(browserA, browserB) {
  console.log();
  console.log('Test: Paired Device Connection Status');

  // Pair A and B
  console.log('  Pairing A and B...');
  const startResult = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  await browserB.testBridge._sendToTabMirror({ action: 'joinPairing', code: startResult.code });

  // Wait for pairing to finish
  let deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const s = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
    if (s.status === 'success') {
      break;
    }
    await sleep(1000);
  }

  // Grab peer IDs
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();

  // Wait for B to show as connected in A's paired list
  // (pairing triggers discoverPeers after 2s delay, so poll)
  console.log('  Waiting for B to show as connected in A...');
  let deviceB_inA;
  deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const devicesA = await browserA.testBridge.getPairedDevices();
    deviceB_inA = devicesA.find(d => d.peerId === stateB.myDeviceId);
    if (deviceB_inA && deviceB_inA.connected) {
      break;
    }
    console.log(`  B in A's paired list: ${!!deviceB_inA}, connected: ${deviceB_inA ? deviceB_inA.connected : 'N/A'}`);
    await sleep(2000);
  }
  console.log(`  B in A's paired list: ${!!deviceB_inA}, connected: ${deviceB_inA ? deviceB_inA.connected : 'N/A'}`);
  await Assert.isTrue(!!deviceB_inA, 'A should have B as paired device');
  await Assert.isTrue(deviceB_inA.connected, 'B should show as connected');

  // Restart B
  console.log('  Simulating restart on B...');
  await browserB.testBridge.simulateRestart();
  await sleep(2000);

  // Check B's status on A -- may briefly show disconnected
  const devicesA_mid = await browserA.testBridge.getPairedDevices();
  const deviceB_mid = devicesA_mid.find(d => d.peerId === stateB.myDeviceId);
  console.log(`  B after restart = in list: ${!!deviceB_mid}, connected: ${deviceB_mid ? deviceB_mid.connected : 'N/A'}`);

  // Wait for B to reconnect
  console.log('  Waiting for B to reconnect...');
  await browserB.testBridge.waitForConnections(1, 30000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);

  // B should show as connected again
  const devicesA_after = await browserA.testBridge.getPairedDevices();
  const deviceB_after = devicesA_after.find(d => d.peerId === stateB.myDeviceId);
  console.log(`  B after reconnect = connected: ${deviceB_after ? deviceB_after.connected : 'N/A'}`);
  await Assert.isTrue(!!deviceB_after, 'A should still have B as paired device');
  await Assert.isTrue(deviceB_after.connected, 'B should show as connected after reconnect');

  // Clean up
  await browserA.testBridge.unpairDevice(stateB.myDeviceId);
  await browserB.testBridge.unpairDevice(stateA.myDeviceId);

  results.pass('Paired Device Connection Status');
}

async function testAuthSucceedsForPairedDevice(browserA, browserB) {
  console.log();
  console.log('Test: Auth Succeeds for Paired Device');

  // Pair A and B
  console.log('  Pairing A and B...');
  const startResult = await browserA.testBridge._sendToTabMirror({ action: 'startPairing' });
  await browserB.testBridge._sendToTabMirror({ action: 'joinPairing', code: startResult.code });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const s = await browserA.testBridge._sendToTabMirror({ action: 'getPairingStatus' });
    if (s.status === 'success') {
      break;
    }
    await sleep(1000);
  }
  await sleep(1000);

  // Check they're paired
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();
  const devicesA = await browserA.testBridge.getPairedDevices();
  await Assert.isTrue(devicesA.some(d => d.peerId === stateB.myDeviceId), 'A should have B as paired');

  // Force auth on next connection for both
  console.log('  Setting forceAuthNextConnection on both A and B...');
  await browserA.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });
  await browserB.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });

  // Restart A -- triggers reconnection through authenticateConnection
  console.log('  Simulating restart on A...');
  await browserA.testBridge.simulateRestart();

  // Wait for reconnection and sync
  console.log('  Waiting for reconnection with authentication...');
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  console.log(`  Reconnected: ${reconnected}`);
  await Assert.isTrue(reconnected, 'A should reconnect to B after auth');

  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);

  // Create tab on A, check it syncs to B (proves auth + sync worked)
  const testUrl = generateTestUrl('auth-success');
  console.log(`  Creating tab on A: ${testUrl}`);
  await browserA.testBridge.createTab(testUrl);
  await browserA.testBridge.waitForSyncComplete(10000);

  console.log('  Waiting for tab to appear on B...');
  const tabInB = await browserB.testBridge.waitForTabUrl(testUrl, 15000);
  console.log(`  Tab found in B: ${!!tabInB}`);
  await Assert.isTrue(!!tabInB, 'Tab should sync to B after authenticated reconnection');

  // Clean up
  await browserA.testBridge.unpairDevice(stateB.myDeviceId);
  await browserB.testBridge.unpairDevice(stateA.myDeviceId);

  results.pass('Auth Succeeds for Paired Device');
}

async function testAuthRejectsUnpairedPeer(browserA, browserB) {
  console.log();
  console.log('Test: Auth Rejects Unpaired Peer');

  // Make sure A and B are NOT paired
  const stateA = await browserA.testBridge.getState();
  const stateB = await browserB.testBridge.getState();
  await browserA.testBridge.unpairDevice(stateB.myDeviceId);
  await browserB.testBridge.unpairDevice(stateA.myDeviceId);
  const devicesA = await browserA.testBridge.getPairedDevices();
  console.log(`  A paired devices: ${devicesA.length} (should be 0 or not contain B)`);

  // Force auth on next connection for both
  console.log('  Setting forceAuthNextConnection on both...');
  await browserA.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });
  await browserB.testBridge._sendToTabMirror({ action: 'forceAuthNextConnection' });

  // Restart A -- triggers reconnection attempt
  console.log('  Simulating restart on A...');
  await browserA.testBridge.simulateRestart();

  // authenticateConnection runs, no shared key, should reject
  // Wait a few seconds for the auth attempt to happen
  await sleep(5000);

  // Check logs for rejection message
  // getLogs() returns the array directly (unwrapped by _sendToTabMirror)
  const logsA = await browserA.testBridge.getLogs();
  const logsB = await browserB.testBridge.getLogs();
  const allLogs = [...(logsA || []).map(l => l.message), ...(logsB || []).map(l => l.message)];
  const hasRejection = allLogs.some(msg => msg && msg.includes('Rejected unpaired peer'));
  console.log(`  Found rejection log: ${hasRejection}`);
  if (!hasRejection) {
    console.log('  Recent logs:');
    allLogs.slice(-10).forEach(msg => console.log(`    ${msg}`));
  }
  await Assert.isTrue(hasRejection, 'Should see "Rejected unpaired peer" in logs');

  // forceAuth is one-shot, so next discovery cycle reconnects normally.
  // Wait for reconnection to confirm extension is healthy
  console.log('  Waiting for normal reconnection (forceAuth is one-shot)...');
  const reconnected = await browserA.testBridge.waitForConnections(1, 30000);
  console.log(`  Reconnected normally: ${reconnected}`);
  await Assert.isTrue(reconnected, 'Should eventually reconnect in normal mode');

  results.pass('Auth Rejects Unpaired Peer');
}

async function testInitialSyncPreservesGroups(browserA, browserB) {
  console.log();
  console.log('Test: Initial Sync Preserves Groups (first contact)');
  console.log('  Both browsers have pre-existing groups, then simulateRestart');
  console.log('  forces a fresh atomic merge. Groups should not be merged.');
  console.log();

  // Create different groups on each browser (they're already connected)
  console.log('  Creating group on Browser A...');
  const a1 = await browserA.testBridge.createTab(generateTestUrl('pair-grp-1'));
  await browserA.testBridge.waitForTabLoad(a1.id);
  const a2 = await browserA.testBridge.createTab(generateTestUrl('pair-grp-2'));
  await browserA.testBridge.waitForTabLoad(a2.id);
  await browserA.testBridge.groupTabs([a1.id, a2.id], 'Pair Group', 'blue');

  console.log('  Creating group on Browser B...');
  const b1 = await browserB.testBridge.createTab(generateTestUrl('join-grp-1'));
  await browserB.testBridge.waitForTabLoad(b1.id);
  const b2 = await browserB.testBridge.createTab(generateTestUrl('join-grp-2'));
  await browserB.testBridge.waitForTabLoad(b2.id);
  await browserB.testBridge.groupTabs([b1.id, b2.id], 'Join Group', 'red');

  // Let incremental sync propagate both groups
  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Both should have 2 groups now (from incremental sync)
  const groupsA_before = await browserA.testBridge.getGroupCount();
  const groupsB_before = await browserB.testBridge.getGroupCount();
  console.log(`  Before restart = A: ${groupsA_before.groups} groups, B: ${groupsB_before.groups} groups`);
  groupsA_before.groupDetails.forEach(g =>
    console.log(`    A: ${g.title} (${g.color}): ${g.tabCount} tabs`)
  );
  groupsB_before.groupDetails.forEach(g =>
    console.log(`    B: ${g.title} (${g.color}): ${g.tabCount} tabs`)
  );
  await Assert.equal(groupsA_before.groups, 2, 'Browser A should have 2 groups before restart');
  await Assert.equal(groupsB_before.groups, 2, 'Browser B should have 2 groups before restart');

  // Restart A -- this clears mappings and forces atomic merge on
  // reconnection (replaceLocalState path). A's Firefox groups still exist
  // but the sync ID mappings are gone.
  console.log();
  console.log('  Simulating restart on Browser A...');
  await browserA.testBridge.simulateRestart();
  await browserB.testBridge.triggerSync();

  await browserA.testBridge.waitForConnections(1, 15000);
  await browserA.testBridge.waitForSyncComplete(15000);
  await browserB.testBridge.waitForSyncComplete(15000);
  // Extra time for secondary sync cycles
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await browserB.testBridge.waitForSyncComplete(10000);

  // Check groups on both browsers
  const groupsA_after = await browserA.testBridge.getGroupCount();
  const groupsB_after = await browserB.testBridge.getGroupCount();

  console.log();
  console.log(`  After restart = A: ${groupsA_after.groups} groups, B: ${groupsB_after.groups} groups`);
  groupsA_after.groupDetails.forEach(g =>
    console.log(`    A: ${g.title} (${g.color}): ${g.tabCount} tabs`)
  );
  groupsB_after.groupDetails.forEach(g =>
    console.log(`    B: ${g.title} (${g.color}): ${g.tabCount} tabs`)
  );

  // Each should still have 2 groups (not merged into 1)
  await Assert.equal(groupsA_after.groups, 2, 'Browser A should still have 2 groups after restart');
  await Assert.equal(groupsA_after.groupedTabs, 4, 'Browser A should have 4 grouped tabs');
  await Assert.equal(groupsB_after.groups, 2, 'Browser B should still have 2 groups after restart');
  await Assert.equal(groupsB_after.groupedTabs, 4, 'Browser B should have 4 grouped tabs');

  // Both group names should exist on each browser
  const aNamesSet = new Set(groupsA_after.groupDetails.map(g => g.title));
  const bNamesSet = new Set(groupsB_after.groupDetails.map(g => g.title));
  await Assert.isTrue(aNamesSet.has('Pair Group'), 'Browser A should still have "Pair Group"');
  await Assert.isTrue(aNamesSet.has('Join Group'), 'Browser A should have "Join Group"');
  await Assert.isTrue(bNamesSet.has('Pair Group'), 'Browser B should have "Pair Group"');
  await Assert.isTrue(bNamesSet.has('Join Group'), 'Browser B should still have "Join Group"');

  // Each group should have exactly 2 tabs (not merged)
  for (const g of groupsA_after.groupDetails) {
    await Assert.equal(g.tabCount, 2, `Browser A group "${g.title}" should have exactly 2 tabs`);
  }
  for (const g of groupsB_after.groupDetails) {
    await Assert.equal(g.tabCount, 2, `Browser B group "${g.title}" should have exactly 2 tabs`);
  }

  results.pass('Initial Sync Preserves Groups');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('TAB OPERATIONS TESTS');
  console.log('═'.repeat(60));

  let browserA, browserB;

  try {
    // Fire up two browsers
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');

    // Set up connection
    console.log();
    console.log('Waiting for connection...');
    const connected = await browserA.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connected, 'Browsers should connect');

    // Wait for initial sync
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('✅ Connected and synced');
    console.log();

    // Run tests -- each wrapped so one failure doesn't stop the suite
    const tests = [
      testInitialSyncPreservesGroups,
      testTabOrdering,
      testTabPinning,
      testTabGroupOperations,
      testComplexTabOperations,
      testOrderPersistenceAcrossChanges,
      testGroupsSurviveReorder,
      testGroupsSurviveReconnection,
      testGroupsNotDuplicatedOnReconnect,
      testReplaceLocalStateIdempotent,
      testGroupsStableAcrossMultipleRestarts,
      testPrivilegedTabOrdering,
      testNavigateToPrivilegedUrl,
      testUnpairRemovesDevice,
      testGroupRemovalSync,
      testSimultaneousGroupCreation,
      testGroupColorTitleSync,
      testRapidGroupOperations,
      testPairingCancel,
      testPairingStatusTransitions,
      testInvalidPairingCode,
      testMultiplePairedDevices,
      testHMACCryptoFunctions,
      testPairingFlow,
      testPairedDeviceConnectionStatus,
      testAuthSucceedsForPairedDevice,
      testAuthRejectsUnpairedPeer,
      testClosingLastTabInGroup,
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
    // Clean up
    console.log();
    console.log('Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
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

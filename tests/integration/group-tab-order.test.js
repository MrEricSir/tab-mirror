#!/usr/bin/env node
/**
 * Group Tab Order Tests
 *
 * Verifies that the order of tabs within a group is preserved during sync.
 * Tests both the initial (atomic merge) and incremental sync paths.
 *
 * Expected results before implementing within-group order sync:
 * - Test 1 (initial sync): may pass (createTargetGroups preserves tabIds order)
 * - Test 2 (reorder within group): should fail (syncGroupsIncremental has no reorder logic)
 * - Test 3 (add tab at position): should fail (incremental sync has no within-group ordering)
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function getGroupTabUrls(testBridge, groupTitle) {
  const tabs = await testBridge.getTabs();
  const groupResult = await testBridge.getGroupCount();
  const group = groupResult.groupDetails.find(g => g.title === groupTitle);
  if (!group) {
    return [];
  }
  return tabs
    .filter(t => t.groupId === group.id)
    .sort((a, b) => a.index - b.index)
    .map(t => t.url);
}

async function testInitialGroupSyncPreservesTabOrder() {
  console.log();
  console.log('Test: Initial Group Sync Preserves Tab Order');

  let browserA, browserB;

  try {
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    await sleep(1500);

    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Initial Group Sync Preserves Tab Order (skipped - no tabGroups API)');
      return;
    }

    // Create 3 tabs with distinct URLs in a specific order
    const url1 = generateTestUrl('order-a');
    const url2 = generateTestUrl('order-b');
    const url3 = generateTestUrl('order-c');

    const t1 = await browserA.testBridge.createTab(url1);
    const t2 = await browserA.testBridge.createTab(url2);
    const t3 = await browserA.testBridge.createTab(url3);
    await sleep(500);

    console.log('  Creating group "Ordered" on A with 3 tabs...');
    try {
      await browserA.testBridge.groupTabs([t1.id, t2.id, t3.id], 'Ordered', 'blue');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        console.log('  Skipping - Tab Groups API not available');
        results.pass('Initial Group Sync Preserves Tab Order (skipped)');
        return;
      }
      throw error;
    }
    await sleep(500);

    // Verify A has the expected order
    const orderA = await getGroupTabUrls(browserA.testBridge, 'Ordered');
    console.log(`  A group order: ${orderA.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(orderA.length, 3, 'A should have 3 tabs in group');
    await Assert.equal(orderA[0], url1, 'A first tab should be url1');
    await Assert.equal(orderA[1], url2, 'A second tab should be url2');
    await Assert.equal(orderA[2], url3, 'A third tab should be url3');

    // Launch B to trigger initial sync
    console.log('  Launching Browser B (triggers initial sync)...');
    browserB = await launchBrowser();

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'A should connect');
    await Assert.isTrue(connectedB, 'B should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify B has same group with same tab order
    const groupB = await browserB.testBridge.waitForGroupState('Ordered', true, 10000);
    await Assert.isTrue(!!groupB, 'B should have "Ordered" group');

    const orderB = await getGroupTabUrls(browserB.testBridge, 'Ordered');
    console.log(`  B group order: ${orderB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(orderB.length, 3, 'B should have 3 tabs in group');
    await Assert.equal(orderB[0], url1, 'B first tab should match A first tab');
    await Assert.equal(orderB[1], url2, 'B second tab should match A second tab');
    await Assert.equal(orderB[2], url3, 'B third tab should match A third tab');

    results.pass('Initial Group Sync Preserves Tab Order');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testReorderWithinGroupSyncs() {
  console.log();
  console.log('Test: Reorder Within Group Syncs to Peer');

  let browserA, browserB;

  try {
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    await sleep(1500);

    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Reorder Within Group Syncs to Peer (skipped - no tabGroups API)');
      return;
    }

    // Create 3 tabs in a group on A
    const url1 = generateTestUrl('reorder-a');
    const url2 = generateTestUrl('reorder-b');
    const url3 = generateTestUrl('reorder-c');

    const t1 = await browserA.testBridge.createTab(url1);
    const t2 = await browserA.testBridge.createTab(url2);
    const t3 = await browserA.testBridge.createTab(url3);
    await sleep(500);

    console.log('  Creating group "Reorder" on A...');
    try {
      await browserA.testBridge.groupTabs([t1.id, t2.id, t3.id], 'Reorder', 'green');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        console.log('  Skipping - Tab Groups API not available');
        results.pass('Reorder Within Group Syncs to Peer (skipped)');
        return;
      }
      throw error;
    }
    await sleep(500);

    // Launch B and wait for initial sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser();

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify initial sync worked
    const initialOrderB = await getGroupTabUrls(browserB.testBridge, 'Reorder');
    console.log(`  B initial order: ${initialOrderB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(initialOrderB.length, 3, 'B should have 3 tabs in group after initial sync');

    // Reorder on A: move the last tab to the first position within the group
    console.log('  Reordering on A: moving last tab to first position...');
    const tabsA = await browserA.testBridge.getTabs();
    const groupResultA = await browserA.testBridge.getGroupCount();
    const groupA = groupResultA.groupDetails.find(g => g.title === 'Reorder');
    const groupTabsA = tabsA
      .filter(t => t.groupId === groupA.id)
      .sort((a, b) => a.index - b.index);

    const lastTab = groupTabsA[groupTabsA.length - 1];
    const firstIndex = groupTabsA[0].index;
    console.log(`  Moving tab ${lastTab.url.split('/').pop()} to index ${firstIndex}`);
    await browserA.testBridge.moveTab(lastTab.id, firstIndex);
    await sleep(500);

    // Verify A now has reordered tabs: url3, url1, url2
    const reorderedA = await getGroupTabUrls(browserA.testBridge, 'Reorder');
    console.log(`  A reordered: ${reorderedA.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(reorderedA[0], url3, 'A first tab should now be url3');
    await Assert.equal(reorderedA[1], url1, 'A second tab should now be url1');
    await Assert.equal(reorderedA[2], url2, 'A third tab should now be url2');

    // Wait for incremental sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify B reflects the new order
    const reorderedB = await getGroupTabUrls(browserB.testBridge, 'Reorder');
    console.log(`  B after reorder: ${reorderedB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(reorderedB.length, 3, 'B should still have 3 tabs');
    await Assert.equal(reorderedB[0], url3, 'B first tab should be url3');
    await Assert.equal(reorderedB[1], url1, 'B second tab should be url1');
    await Assert.equal(reorderedB[2], url2, 'B third tab should be url2');

    results.pass('Reorder Within Group Syncs to Peer');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testAddTabToGroupPreservesOrder() {
  console.log();
  console.log('Test: Add Tab to Group Preserves Order');

  let browserA, browserB;

  try {
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    await sleep(1500);

    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Add Tab to Group Preserves Order (skipped - no tabGroups API)');
      return;
    }

    // Create 3 tabs in a group on A
    const url1 = generateTestUrl('addord-a');
    const url2 = generateTestUrl('addord-b');
    const url3 = generateTestUrl('addord-c');

    const t1 = await browserA.testBridge.createTab(url1);
    const t2 = await browserA.testBridge.createTab(url2);
    const t3 = await browserA.testBridge.createTab(url3);
    await sleep(500);

    console.log('  Creating group "AddOrder" on A...');
    try {
      await browserA.testBridge.groupTabs([t1.id, t2.id, t3.id], 'AddOrder', 'red');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        console.log('  Skipping - Tab Groups API not available');
        results.pass('Add Tab to Group Preserves Order (skipped)');
        return;
      }
      throw error;
    }
    await sleep(500);

    // Launch B and wait for initial sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser();

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify initial sync worked
    const initialOrderB = await getGroupTabUrls(browserB.testBridge, 'AddOrder');
    console.log(`  B initial order: ${initialOrderB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(initialOrderB.length, 3, 'B should have 3 tabs in group after initial sync');

    // Add a new tab to the group on A, inserted at the second position
    console.log('  Adding new tab to group at second position on A...');
    const url4 = generateTestUrl('addord-new');
    const t4 = await browserA.testBridge.createTab(url4);
    await sleep(300);

    // Add to existing group (goes to end of group)
    const groupResultA = await browserA.testBridge.getGroupCount();
    const groupA = groupResultA.groupDetails.find(g => g.title === 'AddOrder');
    await browserA.testBridge.groupTabs([t4.id], 'AddOrder', 'red', groupA.id);
    await sleep(300);

    // Move it from end of group to the second position
    const tabsAfterGroup = await browserA.testBridge.getTabs();
    const groupTabsAfterGroup = tabsAfterGroup
      .filter(t => t.groupId === groupA.id)
      .sort((a, b) => a.index - b.index);
    const url4Tab = groupTabsAfterGroup.find(t => t.url === url4);
    const secondPosition = groupTabsAfterGroup[1].index;
    await browserA.testBridge.moveTab(url4Tab.id, secondPosition);
    await sleep(500);

    // Verify A has the expected order: url1, url4, url2, url3
    const orderA = await getGroupTabUrls(browserA.testBridge, 'AddOrder');
    console.log(`  A after add: ${orderA.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(orderA.length, 4, 'A should have 4 tabs in group');
    await Assert.equal(orderA[0], url1, 'A first tab should be url1');
    await Assert.equal(orderA[1], url4, 'A second tab should be url4 (newly added)');
    await Assert.equal(orderA[2], url2, 'A third tab should be url2');
    await Assert.equal(orderA[3], url3, 'A fourth tab should be url3');

    // Wait for incremental sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify B has the new tab in the correct position
    const orderB = await getGroupTabUrls(browserB.testBridge, 'AddOrder');
    console.log(`  B after add: ${orderB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(orderB.length, 4, 'B should have 4 tabs in group');
    await Assert.equal(orderB[0], url1, 'B first tab should be url1');
    await Assert.equal(orderB[1], url4, 'B second tab should be url4 (newly added)');
    await Assert.equal(orderB[2], url2, 'B third tab should be url2');
    await Assert.equal(orderB[3], url3, 'B fourth tab should be url3');

    results.pass('Add Tab to Group Preserves Order');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testCrossGroupMovePreservesOrder() {
  console.log();
  console.log('Test: Cross-Group Tab Move Preserves Within-Group Order');

  let browserA, browserB;

  try {
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    await sleep(1500);

    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Cross-Group Tab Move Preserves Order (skipped - no tabGroups API)');
      return;
    }

    // Create two groups on A: Alpha [a1, a2, a3], Beta [b1, b2]
    const urlA1 = generateTestUrl('cross-a1');
    const urlA2 = generateTestUrl('cross-a2');
    const urlA3 = generateTestUrl('cross-a3');
    const urlB1 = generateTestUrl('cross-b1');
    const urlB2 = generateTestUrl('cross-b2');

    const tA1 = await browserA.testBridge.createTab(urlA1);
    const tA2 = await browserA.testBridge.createTab(urlA2);
    const tA3 = await browserA.testBridge.createTab(urlA3);
    const tB1 = await browserA.testBridge.createTab(urlB1);
    const tB2 = await browserA.testBridge.createTab(urlB2);
    await sleep(500);

    console.log('  Creating groups Alpha and Beta on A...');
    try {
      await browserA.testBridge.groupTabs([tA1.id, tA2.id, tA3.id], 'Alpha', 'blue');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        console.log('  Skipping - Tab Groups API not available');
        results.pass('Cross-Group Tab Move Preserves Order (skipped)');
        return;
      }
      throw error;
    }
    await browserA.testBridge.groupTabs([tB1.id, tB2.id], 'Beta', 'red');
    await sleep(500);

    // Launch B and wait for initial sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser();

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify initial sync
    const initialAlphaB = await getGroupTabUrls(browserB.testBridge, 'Alpha');
    const initialBetaB = await getGroupTabUrls(browserB.testBridge, 'Beta');
    console.log(`  B initial Alpha: ${initialAlphaB.map(u => u.split('/').pop()).join(', ')}`);
    console.log(`  B initial Beta: ${initialBetaB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(initialAlphaB.length, 3, 'B should have 3 tabs in Alpha');
    await Assert.equal(initialBetaB.length, 2, 'B should have 2 tabs in Beta');

    // Move b1 from Beta into Alpha, between a1 and a2
    // Strategy: add to Alpha group (goes to end), then move within group
    console.log('  Moving b1 from Beta into middle of Alpha on A...');
    const groupResultA = await browserA.testBridge.getGroupCount();
    const alphaA = groupResultA.groupDetails.find(g => g.title === 'Alpha');

    await browserA.testBridge.groupTabs([tB1.id], 'Alpha', 'blue', alphaA.id);
    await sleep(300);

    // Move b1 from end of Alpha to second position (between a1 and a2)
    const tabsAfterRegroup = await browserA.testBridge.getTabs();
    const alphaTabsAfter = tabsAfterRegroup
      .filter(t => t.groupId === alphaA.id)
      .sort((a, b) => a.index - b.index);
    const b1Tab = alphaTabsAfter.find(t => t.url === urlB1);
    const secondIndex = alphaTabsAfter[1].index;
    await browserA.testBridge.moveTab(b1Tab.id, secondIndex);
    await sleep(500);

    // Verify A state: Alpha [a1, b1, a2, a3], Beta [b2]
    const alphaOrderA = await getGroupTabUrls(browserA.testBridge, 'Alpha');
    const betaOrderA = await getGroupTabUrls(browserA.testBridge, 'Beta');
    console.log(`  A Alpha after move: ${alphaOrderA.map(u => u.split('/').pop()).join(', ')}`);
    console.log(`  A Beta after move: ${betaOrderA.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(alphaOrderA.length, 4, 'A Alpha should have 4 tabs');
    await Assert.equal(alphaOrderA[0], urlA1, 'A Alpha[0] = a1');
    await Assert.equal(alphaOrderA[1], urlB1, 'A Alpha[1] = b1 (moved from Beta)');
    await Assert.equal(alphaOrderA[2], urlA2, 'A Alpha[2] = a2');
    await Assert.equal(alphaOrderA[3], urlA3, 'A Alpha[3] = a3');
    await Assert.equal(betaOrderA.length, 1, 'A Beta should have 1 tab');
    await Assert.equal(betaOrderA[0], urlB2, 'A Beta[0] = b2');

    // Wait for incremental sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify B matches: Alpha [a1, b1, a2, a3], Beta [b2]
    const alphaOrderB = await getGroupTabUrls(browserB.testBridge, 'Alpha');
    const betaOrderB = await getGroupTabUrls(browserB.testBridge, 'Beta');
    console.log(`  B Alpha after sync: ${alphaOrderB.map(u => u.split('/').pop()).join(', ')}`);
    console.log(`  B Beta after sync: ${betaOrderB.map(u => u.split('/').pop()).join(', ')}`);
    await Assert.equal(alphaOrderB.length, 4, 'B Alpha should have 4 tabs');
    await Assert.equal(alphaOrderB[0], urlA1, 'B Alpha[0] = a1');
    await Assert.equal(alphaOrderB[1], urlB1, 'B Alpha[1] = b1 (moved from Beta)');
    await Assert.equal(alphaOrderB[2], urlA2, 'B Alpha[2] = a2');
    await Assert.equal(alphaOrderB[3], urlA3, 'B Alpha[3] = a3');
    await Assert.equal(betaOrderB.length, 1, 'B Beta should have 1 tab');
    await Assert.equal(betaOrderB[0], urlB2, 'B Beta[0] = b2');

    results.pass('Cross-Group Tab Move Preserves Within-Group Order');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testSwapGroupOrderPreservesIntraGroupOrder() {
  console.log();
  console.log('Test: Swap Group Order Preserves Intra-Group Tab Order');

  let browserA, browserB;

  try {
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    await sleep(1500);

    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Swap Group Order Preserves Intra-Group Order (skipped - no tabGroups API)');
      return;
    }

    // Create two groups on A: First [f1, f2] then Second [s1, s2]
    const urlF1 = generateTestUrl('swap-f1');
    const urlF2 = generateTestUrl('swap-f2');
    const urlS1 = generateTestUrl('swap-s1');
    const urlS2 = generateTestUrl('swap-s2');

    const tF1 = await browserA.testBridge.createTab(urlF1);
    const tF2 = await browserA.testBridge.createTab(urlF2);
    const tS1 = await browserA.testBridge.createTab(urlS1);
    const tS2 = await browserA.testBridge.createTab(urlS2);
    await sleep(500);

    console.log('  Creating groups "First" and "Second" on A...');
    try {
      await browserA.testBridge.groupTabs([tF1.id, tF2.id], 'First', 'green');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        console.log('  Skipping - Tab Groups API not available');
        results.pass('Swap Group Order Preserves Intra-Group Order (skipped)');
        return;
      }
      throw error;
    }
    await browserA.testBridge.groupTabs([tS1.id, tS2.id], 'Second', 'yellow');
    await sleep(500);

    // Verify initial layout: First [f1, f2], Second [s1, s2]
    const initialFirst = await getGroupTabUrls(browserA.testBridge, 'First');
    const initialSecond = await getGroupTabUrls(browserA.testBridge, 'Second');
    console.log(`  A initial: First [${initialFirst.map(u => u.split('/').pop()).join(', ')}], Second [${initialSecond.map(u => u.split('/').pop()).join(', ')}]`);

    // Launch B and wait for initial sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser();

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Swap group order: move First's tabs to end (ejects from group), then regroup
    // Result should be: Second [s1, s2], First [f1, f2]
    console.log('  Swapping group order on A: moving First tabs to end, then regrouping...');

    // Move f1 to end first, then f2 - this ejects them from First group
    await browserA.testBridge.moveTab(tF1.id, 99);
    await sleep(200);
    await browserA.testBridge.moveTab(tF2.id, 99);
    await sleep(300);

    // f1 and f2 are now ungrouped at the end, after Second
    // Regroup them as "First"
    await browserA.testBridge.groupTabs([tF1.id, tF2.id], 'First', 'green');
    await sleep(500);

    // Verify A state: Second [s1, s2], First [f1, f2]
    const swappedFirst = await getGroupTabUrls(browserA.testBridge, 'First');
    const swappedSecond = await getGroupTabUrls(browserA.testBridge, 'Second');
    console.log(`  A after swap: Second [${swappedSecond.map(u => u.split('/').pop()).join(', ')}], First [${swappedFirst.map(u => u.split('/').pop()).join(', ')}]`);
    await Assert.equal(swappedSecond[0], urlS1, 'A Second[0] = s1');
    await Assert.equal(swappedSecond[1], urlS2, 'A Second[1] = s2');
    await Assert.equal(swappedFirst[0], urlF1, 'A First[0] = f1');
    await Assert.equal(swappedFirst[1], urlF2, 'A First[1] = f2');

    // Verify Second comes before First in global index order
    const allTabsA = await browserA.testBridge.getTabs();
    const s1Global = allTabsA.find(t => t.url === urlS1);
    const f1Global = allTabsA.find(t => t.url === urlF1);
    await Assert.isTrue(s1Global.index < f1Global.index,
      'Second group should come before First group globally');

    // Wait for incremental sync
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Verify B: Second [s1, s2] should come before First [f1, f2]
    const firstOrderB = await getGroupTabUrls(browserB.testBridge, 'First');
    const secondOrderB = await getGroupTabUrls(browserB.testBridge, 'Second');
    console.log(`  B after sync: Second [${secondOrderB.map(u => u.split('/').pop()).join(', ')}], First [${firstOrderB.map(u => u.split('/').pop()).join(', ')}]`);

    // Within-group order should be preserved
    await Assert.equal(secondOrderB.length, 2, 'B Second should have 2 tabs');
    await Assert.equal(secondOrderB[0], urlS1, 'B Second[0] = s1');
    await Assert.equal(secondOrderB[1], urlS2, 'B Second[1] = s2');
    await Assert.equal(firstOrderB.length, 2, 'B First should have 2 tabs');
    await Assert.equal(firstOrderB[0], urlF1, 'B First[0] = f1');
    await Assert.equal(firstOrderB[1], urlF2, 'B First[1] = f2');

    // Verify Second comes before First globally on B too
    const allTabsB = await browserB.testBridge.getTabs();
    const s1GlobalB = allTabsB.find(t => t.url === urlS1);
    const f1GlobalB = allTabsB.find(t => t.url === urlF1);
    await Assert.isTrue(s1GlobalB.index < f1GlobalB.index,
      'B: Second group should come before First group globally');

    results.pass('Swap Group Order Preserves Intra-Group Tab Order');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('GROUP TAB ORDER TESTS');
  console.log('='.repeat(60));

  const tests = [
    testInitialGroupSyncPreservesTabOrder,
    testReorderWithinGroupSyncs,
    testAddTabToGroupPreservesOrder,
    testCrossGroupMovePreservesOrder,
    testSwapGroupOrderPreservesIntraGroupOrder,
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

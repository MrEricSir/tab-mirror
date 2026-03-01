#!/usr/bin/env node
/**
 * Initial Group Sync Tests
 *
 * Reproduces a bug where initial sync creates a duplicate tab group
 * containing only a "new tab" that wasn't in the original group.
 *
 * Root cause: during replaceLocalState, browser.tabs.create() can cause
 * Firefox to auto-group newly created tabs into an existing group. The
 * ungroup step only ungrouped adopted tabs, not created ones, so the
 * stale group stayed alive with the auto-grouped tab.
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testInitialSyncNoGroupDuplication() {
  console.log();
  console.log('Test: Initial Sync Does Not Duplicate Tab Groups');

  let browserA, browserB;

  try {
    // Launch A first, set up a group before B connects
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    console.log('  Browser A launched');

    // Let A fully init (no peers yet)
    await sleep(1500);

    // See if tabGroups API is available
    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Initial Sync Does Not Duplicate Tab Groups (skipped - no tabGroups API)');
      return;
    }

    // Create tabs and group them on A
    const t1 = await browserA.testBridge.createTab(generateTestUrl('init-grp-1'));
    const t2 = await browserA.testBridge.createTab(generateTestUrl('init-grp-2'));
    await sleep(500);

    console.log('  Creating group "Project" on A...');
    try {
      await browserA.testBridge.groupTabs([t1.id, t2.id], 'Project', 'green');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        console.log('  Skipping - Tab Groups API not available');
        results.pass('Initial Sync Does Not Duplicate Tab Groups (skipped)');
        return;
      }
      throw error;
    }
    await sleep(500);

    // A should have exactly 1 group with 2 tabs
    const groupsA = await browserA.testBridge.getGroupCount();
    const projectGroupsA = groupsA.groupDetails.filter(g => g.title === 'Project');
    console.log(`  A has ${projectGroupsA.length} "Project" group(s) with ${projectGroupsA.map(g => g.tabCount).join(',')} tabs`);
    await Assert.equal(projectGroupsA.length, 1, 'A should have exactly 1 "Project" group before sync');
    await Assert.equal(projectGroupsA[0].tabCount, 2, 'A "Project" group should have 2 tabs');

    // NOW launch B -- this triggers initial sync
    console.log('  Launching Browser B (triggers initial sync)...');
    browserB = await launchBrowser();
    console.log('  Browser B launched');

    // Wait for connection and initial sync
    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'A should connect');
    await Assert.isTrue(connectedB, 'B should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);  // extra time for groups to settle
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // A should still have exactly 1 "Project" group
    const groupsAfterA = await browserA.testBridge.getGroupCount();
    const projectAfterA = groupsAfterA.groupDetails.filter(g => g.title === 'Project');
    console.log(`  A after sync: ${projectAfterA.length} "Project" group(s)`);
    projectAfterA.forEach(g => console.log(`    - ${g.tabCount} tabs, color: ${g.color}`));

    // B should have exactly 1 "Project" group
    const groupsAfterB = await browserB.testBridge.getGroupCount();
    const projectAfterB = groupsAfterB.groupDetails.filter(g => g.title === 'Project');
    console.log(`  B after sync: ${projectAfterB.length} "Project" group(s)`);
    projectAfterB.forEach(g => console.log(`    - ${g.tabCount} tabs, color: ${g.color}`));

    // A should still have exactly 1 "Project" group, not a duplicate
    await Assert.equal(projectAfterA.length, 1,
      'A should have exactly 1 "Project" group after sync (no duplicate)');
    await Assert.equal(projectAfterA[0].tabCount, 2,
      'A "Project" group should still have 2 tabs');

    await Assert.equal(projectAfterB.length, 1,
      'B should have exactly 1 "Project" group after sync');
    await Assert.equal(projectAfterB[0].tabCount, 2,
      'B "Project" group should have 2 tabs');

    // Make sure no unexpected groups exist
    const totalGroupsA = groupsAfterA.groupDetails.length;
    const totalGroupsB = groupsAfterB.groupDetails.length;
    console.log(`  Total groups - A: ${totalGroupsA}, B: ${totalGroupsB}`);
    await Assert.equal(totalGroupsA, 1, 'A should have exactly 1 group total');
    await Assert.equal(totalGroupsB, 1, 'B should have exactly 1 group total');

    results.pass('Initial Sync Does Not Duplicate Tab Groups');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function testInitialSyncMultipleGroups() {
  console.log();
  console.log('Test: Initial Sync With Multiple Groups');

  let browserA, browserB;

  try {
    console.log('  Launching Browser A...');
    browserA = await launchBrowser();
    await sleep(1500);

    const groupCheck = await browserA.testBridge.getGroupCount();
    if (groupCheck.error) {
      console.log('  tabGroups API not available, skipping');
      results.pass('Initial Sync With Multiple Groups (skipped)');
      return;
    }

    // Set up two separate groups on A
    const t1 = await browserA.testBridge.createTab(generateTestUrl('multi-grp-a1'));
    const t2 = await browserA.testBridge.createTab(generateTestUrl('multi-grp-a2'));
    const t3 = await browserA.testBridge.createTab(generateTestUrl('multi-grp-b1'));
    const t4 = await browserA.testBridge.createTab(generateTestUrl('multi-grp-b2'));
    await sleep(500);

    console.log('  Creating group "Alpha" (blue) on A...');
    try {
      await browserA.testBridge.groupTabs([t1.id, t2.id], 'Alpha', 'blue');
    } catch (error) {
      if (error.message && error.message.includes('Tab Groups API not available')) {
        results.pass('Initial Sync With Multiple Groups (skipped)');
        return;
      }
      throw error;
    }

    console.log('  Creating group "Beta" (red) on A...');
    await browserA.testBridge.groupTabs([t3.id, t4.id], 'Beta', 'red');
    await sleep(500);

    // A should have 2 groups
    const groupsA = await browserA.testBridge.getGroupCount();
    console.log(`  A has ${groupsA.groupDetails.length} groups before sync`);
    await Assert.equal(groupsA.groupDetails.length, 2, 'A should have 2 groups');

    // Launch B and let it sync
    console.log('  Launching Browser B...');
    browserB = await launchBrowser();
    console.log('  Browser B launched');

    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA && connectedB, 'Both should connect');

    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);
    await sleep(1500);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // A should still have exactly 2 groups
    const groupsAfterA = await browserA.testBridge.getGroupCount();
    const alphaA = groupsAfterA.groupDetails.filter(g => g.title === 'Alpha');
    const betaA = groupsAfterA.groupDetails.filter(g => g.title === 'Beta');
    console.log(`  A after sync: ${groupsAfterA.groupDetails.length} total groups`);
    console.log(`    Alpha: ${alphaA.length} group(s), ${alphaA.map(g => g.tabCount + ' tabs').join(', ')}`);
    console.log(`    Beta: ${betaA.length} group(s), ${betaA.map(g => g.tabCount + ' tabs').join(', ')}`);

    await Assert.equal(groupsAfterA.groupDetails.length, 2, 'A should still have exactly 2 groups');
    await Assert.equal(alphaA.length, 1, 'A should have 1 Alpha group');
    await Assert.equal(betaA.length, 1, 'A should have 1 Beta group');

    // B should also have exactly 2 groups
    const groupsAfterB = await browserB.testBridge.getGroupCount();
    const alphaB = groupsAfterB.groupDetails.filter(g => g.title === 'Alpha');
    const betaB = groupsAfterB.groupDetails.filter(g => g.title === 'Beta');
    console.log(`  B after sync: ${groupsAfterB.groupDetails.length} total groups`);
    console.log(`    Alpha: ${alphaB.length} group(s), ${alphaB.map(g => g.tabCount + ' tabs').join(', ')}`);
    console.log(`    Beta: ${betaB.length} group(s), ${betaB.map(g => g.tabCount + ' tabs').join(', ')}`);

    await Assert.equal(groupsAfterB.groupDetails.length, 2, 'B should have exactly 2 groups');
    await Assert.equal(alphaB.length, 1, 'B should have 1 Alpha group');
    await Assert.equal(betaB.length, 1, 'B should have 1 Beta group');

    results.pass('Initial Sync With Multiple Groups');
  } finally {
    console.log('  Cleaning up...');
    await cleanupBrowser(browserA);
    await cleanupBrowser(browserB);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('INITIAL GROUP SYNC TESTS');
  console.log('='.repeat(60));

  const tests = [
    testInitialSyncNoGroupDuplication,
    testInitialSyncMultipleGroups,
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

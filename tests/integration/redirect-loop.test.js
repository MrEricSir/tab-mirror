#!/usr/bin/env node
/**
 * Redirect Loop Prevention Tests
 *
 * Verifies that auth redirects and URL bouncing don't cause sync loops:
 * - Redirect sync-back suppression (primary defense)
 * - Bounce detection (safety net)
 * - Legitimate navigation still syncs after suppression window
 * - Rapid redirect chains are suppressed
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testRedirectSyncBack(browserA, browserB) {
  console.log();
  console.log('Test: Redirect Sync-Back Suppression');

  // Shorten the suppression window for faster tests
  await browserA.testBridge.setRedirectSuppressionWindow(5000);
  await browserB.testBridge.setRedirectSuppressionWindow(5000);

  // A creates a tab at a "login-protected" page
  const protectedUrl = generateTestUrl('account-page-XYZ');
  console.log(`  Creating tab in A: ${protectedUrl}`);
  const tab = await browserA.testBridge.createTab(protectedUrl);
  await browserA.testBridge.waitForTabLoad(tab.id);

  // Wait for sync to B
  console.log('  Waiting for tab to sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const bTab = await browserB.testBridge.waitForTabUrl('account-page-XYZ', 20000);
  await Assert.isTrue(!!bTab, 'Tab should sync to Browser B');
  console.log(`  Tab synced to B: tab ${bTab.id}`);

  // Simulate auth redirect on B: site redirects to /login
  const loginUrl = generateTestUrl('login-redirect-XYZ');
  console.log(`  Simulating auth redirect on B: ${loginUrl}`);
  await browserB.testBridge.updateTab(bTab.id, { url: loginUrl });
  await browserB.testBridge.waitForTabLoad(bTab.id);

  // Wait for potential sync-back (give time for any erroneous broadcast)
  console.log('  Waiting for potential sync-back...');
  await sleep(4000);

  // A's tab should still show the original URL, not the login redirect
  const tabsA = await browserA.testBridge.getTabs();
  const aTab = tabsA.find(t => t.url && t.url.includes('account-page-XYZ'));
  const wrongTab = tabsA.find(t => t.url && t.url.includes('login-redirect-XYZ'));

  console.log(`  A still has original URL: ${!!aTab}`);
  console.log(`  A has redirect URL (BAD): ${!!wrongTab}`);

  await Assert.isTrue(!!aTab, 'Browser A should still have the original page URL');
  await Assert.isTrue(!wrongTab, 'Browser A should NOT have the login redirect URL');

  results.pass('Redirect Sync-Back Suppression');
}

async function testBounceLoopDetected(browserA, browserB) {
  console.log();
  console.log('Test: Bounce Loop Detection');

  await browserA.testBridge.setRedirectSuppressionWindow(5000);
  await browserB.testBridge.setRedirectSuppressionWindow(5000);

  // A creates tab at /dashboard
  const dashboardUrl = generateTestUrl('dashboard-XYZ');
  console.log(`  Creating tab in A: ${dashboardUrl}`);
  const tab = await browserA.testBridge.createTab(dashboardUrl);
  await browserA.testBridge.waitForTabLoad(tab.id);

  // Wait for sync to B
  console.log('  Waiting for sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const bTab = await browserB.testBridge.waitForTabUrl('dashboard-XYZ', 20000);
  await Assert.isTrue(!!bTab, 'Dashboard should sync to B');

  // B "redirects" to /login (simulating not-logged-in)
  const loginUrl = generateTestUrl('login-XYZ');
  console.log(`  B redirects to login: ${loginUrl}`);
  await browserB.testBridge.updateTab(bTab.id, { url: loginUrl });
  await browserB.testBridge.waitForTabLoad(bTab.id);

  // Wait and check stability
  await sleep(5000);

  // Check both browsers for stability - neither should be bouncing
  const tabsA = await browserA.testBridge.getTabs();
  const tabsB = await browserB.testBridge.getTabs();

  const aDashboard = tabsA.find(t => t.url && t.url.includes('dashboard-XYZ'));
  const aLogin = tabsA.find(t => t.url && t.url.includes('login-XYZ'));
  const bLogin = tabsB.find(t => t.url && t.url.includes('login-XYZ'));

  console.log(`  A has dashboard: ${!!aDashboard}`);
  console.log(`  A has login (BAD): ${!!aLogin}`);
  console.log(`  B has login: ${!!bLogin}`);

  // A should still show dashboard (redirect suppressed), B stays on login
  await Assert.isTrue(!!aDashboard, 'A should still have dashboard URL');
  await Assert.isTrue(!aLogin, 'A should NOT have login URL synced back');

  results.pass('Bounce Loop Detection');
}

async function testLegitimateNavigationStillSyncs(browserA, browserB) {
  console.log();
  console.log('Test: Legitimate Navigation Still Syncs After Suppression Window');

  // Use a short suppression window so we can wait it out
  await browserA.testBridge.setRedirectSuppressionWindow(3000);
  await browserB.testBridge.setRedirectSuppressionWindow(3000);

  // A creates a tab, syncs to B
  const initialUrl = generateTestUrl('legit-initial-XYZ');
  console.log(`  Creating tab in A: ${initialUrl}`);
  const tab = await browserA.testBridge.createTab(initialUrl);
  await browserA.testBridge.waitForTabLoad(tab.id);

  console.log('  Waiting for sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const bTab = await browserB.testBridge.waitForTabUrl('legit-initial-XYZ', 20000);
  await Assert.isTrue(!!bTab, 'Initial tab should sync to B');

  // Wait for suppression window to expire
  console.log('  Waiting for suppression window to expire...');
  await sleep(4000);

  // B navigates to a new URL (genuine user action)
  const newUrl = generateTestUrl('legit-user-navigate-XYZ');
  console.log(`  B navigates to: ${newUrl}`);
  await browserB.testBridge.updateTab(bTab.id, { url: newUrl });
  await browserB.testBridge.waitForTabLoad(bTab.id);

  // This should sync back to A
  console.log('  Waiting for legitimate navigation to sync to A...');
  await browserB.testBridge.waitForSyncComplete(10000);
  const aTab = await browserA.testBridge.waitForTabUrl('legit-user-navigate-XYZ', 20000);

  await Assert.isTrue(!!aTab, 'Legitimate navigation should sync back to A after suppression window');

  results.pass('Legitimate Navigation Still Syncs After Suppression Window');
}

async function testMultipleRedirectsSuppressed(browserA, browserB) {
  console.log();
  console.log('Test: Multiple Rapid Redirects Suppressed');

  await browserA.testBridge.setRedirectSuppressionWindow(5000);
  await browserB.testBridge.setRedirectSuppressionWindow(5000);

  // A creates tab, syncs to B
  const originalUrl = generateTestUrl('multi-redir-original-XYZ');
  console.log(`  Creating tab in A: ${originalUrl}`);
  const tab = await browserA.testBridge.createTab(originalUrl);
  await browserA.testBridge.waitForTabLoad(tab.id);

  console.log('  Waiting for sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const bTab = await browserB.testBridge.waitForTabUrl('multi-redir-original-XYZ', 20000);
  await Assert.isTrue(!!bTab, 'Tab should sync to B');

  // B fires 3 rapid URL changes (simulating redirect chain)
  const redir1 = generateTestUrl('redir-chain-1-XYZ');
  const redir2 = generateTestUrl('redir-chain-2-XYZ');
  const redir3 = generateTestUrl('redir-chain-3-XYZ');

  console.log('  Firing 3 rapid redirects on B...');
  await browserB.testBridge.updateTab(bTab.id, { url: redir1 });
  await sleep(200);
  await browserB.testBridge.updateTab(bTab.id, { url: redir2 });
  await sleep(200);
  await browserB.testBridge.updateTab(bTab.id, { url: redir3 });

  // Wait for any potential sync-back
  console.log('  Waiting for potential sync-back...');
  await sleep(4000);

  // None of the redirect URLs should appear in A
  const tabsA = await browserA.testBridge.getTabs();
  const hasRedir1 = tabsA.some(t => t.url && t.url.includes('redir-chain-1-XYZ'));
  const hasRedir2 = tabsA.some(t => t.url && t.url.includes('redir-chain-2-XYZ'));
  const hasRedir3 = tabsA.some(t => t.url && t.url.includes('redir-chain-3-XYZ'));
  const hasOriginal = tabsA.some(t => t.url && t.url.includes('multi-redir-original-XYZ'));

  console.log(`  A has original: ${hasOriginal}`);
  console.log(`  A has redir1 (BAD): ${hasRedir1}`);
  console.log(`  A has redir2 (BAD): ${hasRedir2}`);
  console.log(`  A has redir3 (BAD): ${hasRedir3}`);

  await Assert.isTrue(hasOriginal, 'A should still have the original URL');
  await Assert.isTrue(!hasRedir1, 'Redirect 1 should NOT sync back to A');
  await Assert.isTrue(!hasRedir2, 'Redirect 2 should NOT sync back to A');
  await Assert.isTrue(!hasRedir3, 'Redirect 3 should NOT sync back to A');

  results.pass('Multiple Rapid Redirects Suppressed');
}

async function testNavigationOnSenderNotSuppressed(browserA, browserB) {
  console.log();
  console.log('Test: Navigation on Sender Not Suppressed by Echo');

  await browserA.testBridge.setRedirectSuppressionWindow(5000);
  await browserB.testBridge.setRedirectSuppressionWindow(5000);

  // A creates a tab at URL1, syncs to B
  const url1 = generateTestUrl('sender-nav-initial-XYZ');
  console.log(`  Creating tab in A: ${url1}`);
  const tab = await browserA.testBridge.createTab(url1);
  await browserA.testBridge.waitForTabLoad(tab.id);

  console.log('  Waiting for sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const bTab = await browserB.testBridge.waitForTabUrl('sender-nav-initial-XYZ', 20000);
  await Assert.isTrue(!!bTab, 'Tab should sync to B');
  console.log(`  Tab synced to B: tab ${bTab.id}`);

  // Wait for echo — B broadcasts its state back, A processes it
  console.log('  Waiting for echo round-trip...');
  await browserB.testBridge.waitForSyncComplete(10000);
  await browserA.testBridge.waitForSyncComplete(10000);
  await sleep(2000);

  // A navigates that tab to URL2 (simulating the user clicking a link)
  const url2 = generateTestUrl('sender-nav-clicked-XYZ');
  console.log(`  A navigates to: ${url2}`);
  await browserA.testBridge.updateTab(tab.id, { url: url2 });
  await browserA.testBridge.waitForTabLoad(tab.id);

  // URL2 should sync to B
  console.log('  Waiting for new URL to sync to B...');
  await browserA.testBridge.waitForSyncComplete(10000);
  const bTab2 = await browserB.testBridge.waitForTabUrl('sender-nav-clicked-XYZ', 20000);

  await Assert.isTrue(!!bTab2, 'User navigation on sender should sync to receiver (not suppressed by echo)');

  results.pass('Navigation on Sender Not Suppressed by Echo');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('REDIRECT LOOP PREVENTION TESTS');
  console.log('═'.repeat(60));

  let browserA, browserB;

  try {
    // Launch two browsers
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    // Wait for connection
    console.log('Waiting for connection...');
    const connA = await browserA.testBridge.waitForConnections(1, 30000);
    const connB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connA, 'Browser A should connect');
    await Assert.isTrue(connB, 'Browser B should connect');

    // Wait for initial sync
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Run tests
    const tests = [
      testRedirectSyncBack,
      testBounceLoopDetected,
      testLegitimateNavigationStillSyncs,
      testMultipleRedirectsSuppressed,
      testNavigationOnSenderNotSuppressed,
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

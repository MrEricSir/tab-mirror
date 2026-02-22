#!/usr/bin/env node
/**
 * Sync Window Tests
 *
 * Checks that sync is restricted to a single designated non-private window:
 * - syncWindowId picked at boot
 * - syncWindowId exposed in state
 * - Tabs in sync window sync normally
 * - Tabs in a second window don't sync
 * - Closing sync window adopts another window
 * - After adoption, new tabs still sync
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testSyncWindowSelectedAtBoot(browserA, browserB) {
  console.log();
  console.log('Test: Sync Window Selected at Boot');

  const syncWinA = await browserA.testBridge.getSyncWindowId();
  const syncWinB = await browserB.testBridge.getSyncWindowId();

  console.log(`  Browser A syncWindowId: ${syncWinA}`);
  console.log(`  Browser B syncWindowId: ${syncWinB}`);

  await Assert.isTrue(syncWinA !== null && syncWinA !== undefined, 'Browser A should have a syncWindowId');
  await Assert.isTrue(syncWinB !== null && syncWinB !== undefined, 'Browser B should have a syncWindowId');

  // Check syncWindowId matches a real window
  const windowsA = await browserA.testBridge.getWindows();
  const windowsB = await browserB.testBridge.getWindows();

  const windowIdsA = windowsA.map(w => w.id);
  const windowIdsB = windowsB.map(w => w.id);

  console.log(`  Browser A window IDs: ${windowIdsA.join(', ')}`);
  console.log(`  Browser B window IDs: ${windowIdsB.join(', ')}`);

  await Assert.includes(windowIdsA, syncWinA, 'Browser A syncWindowId should match a real window');
  await Assert.includes(windowIdsB, syncWinB, 'Browser B syncWindowId should match a real window');

  results.pass('Sync Window Selected at Boot');
}

async function testSyncWindowIdExposedInState(browserA) {
  console.log();
  console.log('Test: syncWindowId Exposed in State');

  const state = await browserA.testBridge.getState();

  console.log(`  State keys: ${Object.keys(state).join(', ')}`);
  console.log(`  syncWindowId: ${state.syncWindowId} (type: ${typeof state.syncWindowId})`);

  await Assert.isTrue('syncWindowId' in state, 'State should contain syncWindowId property');
  await Assert.isTrue(typeof state.syncWindowId === 'number', 'syncWindowId should be a number');

  results.pass('syncWindowId Exposed in State');
}

async function testTabsInSyncWindowSync(browserA, browserB) {
  console.log();
  console.log('Test: Tabs in Sync Window Still Sync Normally');

  const uniqueUrl = generateTestUrl('sync-win-tab');
  console.log(`  Creating tab in Browser A sync window: ${uniqueUrl}`);
  await browserA.testBridge.createTab(uniqueUrl);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  console.log('  Waiting for URL to appear in Browser B...');
  const found = await browserB.testBridge.waitForTabUrl('sync-win-tab', 20000);

  await Assert.isTrue(!!found, 'Tab created in sync window should sync to Browser B');

  results.pass('Tabs in Sync Window Still Sync Normally');
}

async function testTabsInSecondWindowDontSync(browserA, browserB) {
  console.log();
  console.log('Test: Tabs in Second Window Don\'t Sync');

  const initialTabsB = await browserB.testBridge.getTabs();
  const initialCountB = initialTabsB.length;
  console.log(`  Browser B initial tab count: ${initialCountB}`);

  // Open a second window in A with a unique URL
  const uniqueUrl = generateTestUrl('non-sync-tab');
  console.log(`  Creating second window in Browser A: ${uniqueUrl}`);
  const newWindow = await browserA.testBridge.createWindow(uniqueUrl);
  const newWindowId = newWindow.id;
  console.log(`  New window ID: ${newWindowId}`);

  // Wait for any sync activity to settle
  await sleep(3000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // Extra time in case sync would propagate (it shouldn't)
  await sleep(5000);

  // B should NOT have the non-sync-tab URL
  const tabsB = await browserB.testBridge.getTabs();
  const hasNonSyncTab = tabsB.some(t => t.url && t.url.includes('non-sync-tab'));
  const countB = tabsB.length;

  console.log(`  Browser B tab count: ${countB} (was ${initialCountB})`);
  console.log(`  Browser B has non-sync-tab URL: ${hasNonSyncTab}`);

  await Assert.isTrue(!hasNonSyncTab, 'Browser B should NOT have the non-sync-tab URL');
  await Assert.equal(countB, initialCountB, 'Browser B tab count should not change');

  // Clean up: close the extra window
  console.log(`  Closing extra window ${newWindowId}...`);
  await browserA.testBridge.closeWindow(newWindowId);
  await sleep(1000);

  results.pass('Tabs in Second Window Don\'t Sync');
}

async function testClosingSyncWindowAdoptsFallback(browserA) {
  console.log();
  console.log('Test: Closing Sync Window Adopts Fallback Window');

  const originalSyncWindowId = await browserA.testBridge.getSyncWindowId();
  console.log(`  Original syncWindowId: ${originalSyncWindowId}`);

  // Remember which Selenium handle has testBridge (in the sync window)
  const syncHandle = await browserA.driver.getWindowHandle();

  // Record handles before creating fallback window so we can diff
  const handlesBefore = await browserA.driver.getAllWindowHandles();

  // Open a second window as a fallback candidate
  const fallbackUrl = generateTestUrl('fallback-window');
  console.log(`  Creating fallback window: ${fallbackUrl}`);
  const fallbackWindow = await browserA.testBridge.createWindow(fallbackUrl);
  console.log(`  Fallback window ID: ${fallbackWindow.id}`);

  await sleep(2000);

  // Navigate old testbridge-init page to about:blank so init() won't find it
  console.log(`  Clearing TestBridge from sync window...`);
  await browserA.driver.get('about:blank');
  await sleep(500);

  // Find fallback window's Selenium handle by diffing before/after
  const handlesAfter = await browserA.driver.getAllWindowHandles();
  console.log(`  Selenium window handles: ${handlesAfter.length} (was ${handlesBefore.length})`);
  const fallbackHandle = handlesAfter.find(h => !handlesBefore.includes(h));
  await Assert.isTrue(!!fallbackHandle, 'Should find the fallback Selenium window handle');

  // Switch to fallback window, set up testBridge there
  console.log(`  Switching Selenium to fallback window...`);
  await browserA.driver.switchTo().window(fallbackHandle);

  // Navigate to testbridge-init URL so the content script loads
  const bridgeUrl = generateTestUrl('testbridge-init');
  console.log(`  Navigating fallback window to testbridge-init URL...`);
  await browserA.driver.get(bridgeUrl);

  // Wait for TestBridge in THIS window specifically
  // (don't use init() -- it scans all handles and may switch to a different window)
  await browserA.driver.wait(async () => {
    try {
      return await browserA.driver.executeScript(() => typeof window.TestBridge !== 'undefined');
    } catch (e) { return false; }
  }, 10000, 'TestBridge not injected in fallback window');
  browserA.testBridge.ready = true;

  // Close the original sync window via bridge API.
  // May throw "Document was unloaded" if Firefox briefly disrupts the page
  // during window management -- the close still succeeds, and the polling
  // loop below checks adoption.
  console.log(`  Closing original sync window ${originalSyncWindowId}...`);
  try {
    await browserA.testBridge.closeWindow(originalSyncWindowId);
  } catch (e) {
    console.log(`  closeWindow threw (expected during window transition): ${e.message}`);
  }

  // Poll until adoption completes (syncWindowId flips to the fallback)
  let newSyncWindowId = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      newSyncWindowId = await browserA.testBridge.getSyncWindowId();
      if (newSyncWindowId !== null && newSyncWindowId !== originalSyncWindowId) {
        break;
      }
    } catch (e) {
      console.log(`  Waiting for adoption (${e.message})...`);
    }
  }
  console.log(`  syncWindowId after close: ${newSyncWindowId}`);

  await Assert.isTrue(newSyncWindowId !== null, 'syncWindowId should not be null: Fallback should be adopted');
  await Assert.isTrue(newSyncWindowId !== originalSyncWindowId, 'syncWindowId should differ from the closed window');
  await Assert.equal(newSyncWindowId, fallbackWindow.id, 'syncWindowId should be the fallback window');

  results.pass('Closing Sync Window Adopts Fallback Window');
}

async function testAfterSyncWindowAdoptedTabsStillSync(browserA, browserB) {
  console.log();
  console.log('Test: After Sync Window Adopted, New Tabs Still Sync');

  // At this point A's syncWindowId should be the fallback window
  const syncWin = await browserA.testBridge.getSyncWindowId();
  console.log(`  Browser A syncWindowId: ${syncWin}`);
  await Assert.isTrue(syncWin !== null, 'Precondition: syncWindowId should not be null');

  // Create a tab in A's adopted sync window
  const uniqueUrl = generateTestUrl('after-adopt');
  console.log(`  Creating tab in Browser A: ${uniqueUrl}`);
  await browserA.testBridge.createTab(uniqueUrl);

  await sleep(2000);
  await browserA.testBridge.waitForSyncComplete(10000);

  // B should have the after-adopt URL
  console.log('  Waiting for URL to appear in Browser B...');
  const found = await browserB.testBridge.waitForTabUrl('after-adopt', 20000);

  await Assert.isTrue(!!found, 'Browser B should have the after-adopt URL');

  results.pass('After Sync Window Adopted, New Tabs Still Sync');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('SYNC WINDOW TESTS');
  console.log('═'.repeat(60));

  let browserA, browserB;

  try {
    // Launch two browsers
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('✅ Browsers launched');

    // Wait for connection + initial sync
    console.log();
    console.log('Waiting for connection...');
    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'Browser A should connect');
    await Assert.isTrue(connectedB, 'Browser B should connect');

    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('✅ Connected and synced');

    // Run tests -- each wrapped so one failure doesn't stop the suite
    // Tests 5 & 6 must run last since they mutate A's state
    const tests = [
      () => testSyncWindowSelectedAtBoot(browserA, browserB),
      () => testSyncWindowIdExposedInState(browserA),
      () => testTabsInSyncWindowSync(browserA, browserB),
      () => testTabsInSecondWindowDontSync(browserA, browserB),
      () => testClosingSyncWindowAdoptsFallback(browserA),
      () => testAfterSyncWindowAdoptedTabsStillSync(browserA, browserB),
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

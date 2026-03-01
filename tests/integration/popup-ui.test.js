#!/usr/bin/env node
/**
 * Popup UI Tests
 *
 * Opens popup.html in a tab via moz-extension:// URL and checks
 * that the UI renders correctly and reflects extension state:
 * - Basic elements render (header, device name, sync toggle, pair buttons)
 * - Status dot reflects connection state
 * - Advanced section toggles and shows debug info
 * - Sync history shows events
 * - Sync status line shows tab count and last sync time when paired
 * - Sync status line is empty when unpaired
 * - Pair buttons visible from non-sync window
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

/**
 * Open the popup in a new tab. Returns handles needed to close it later.
 * Popup polls every 1s, so we wait for it to populate.
 */
async function openPopup(browser) {
    const { driver, testBridge } = browser;

    const popupUrl = await testBridge.getPopupUrl();
    if (!popupUrl) {
        throw new Error('Could not get popup URL');
    }

    // Save handle list before opening new tab
    const handlesBefore = await driver.getAllWindowHandles();

    await driver.switchTo().newWindow('tab');
    const popupHandle = await driver.getWindowHandle();
    await driver.get(popupUrl);

    // Wait for popup JS to load and first updateUI() poll to complete
    await sleep(2500);

    return { popupHandle, handlesBefore };
}

/**
 * Close the popup tab and re-establish the bridge connection.
 * getPopupUrl() navigated away from the HTTP page, so reset() is needed.
 */
async function closePopup(driver, popupHandle, handlesBefore, testBridge) {
    await driver.switchTo().window(popupHandle);
    await driver.close();
    await driver.switchTo().window(handlesBefore[0]);
    await testBridge.reset();
}

/**
 * Run a script in the popup tab context.
 */
async function queryPopup(driver, script) {
    return driver.executeScript(script);
}

// Tests

async function testPopupRendersBasicElements(browser) {
    console.log();
    console.log('Test: Popup Renders Basic Elements');
    const { driver } = browser;

    const { popupHandle, handlesBefore } = await openPopup(browser);

    try {
        const header = await queryPopup(driver, 'return document.querySelector(".header")?.textContent');
        console.log(`  Header: "${header}"`);
        await Assert.isTrue(header === 'Tab Mirror', `Header should be "Tab Mirror", got "${header}"`);

        const deviceName = await queryPopup(driver, 'return document.getElementById("deviceName")?.textContent');
        console.log(`  Device name: "${deviceName}"`);
        await Assert.isTrue(deviceName && deviceName !== '...', `Device name should load, got "${deviceName}"`);

        const toggleChecked = await queryPopup(driver, 'return document.getElementById("syncToggle")?.checked');
        console.log(`  Sync toggle checked: ${toggleChecked}`);
        await Assert.isTrue(toggleChecked === true, 'Sync toggle should be checked (enabled)');

        // Pair buttons should show up
        const pairBtnDisplay = await queryPopup(driver,
            'return getComputedStyle(document.getElementById("pairButtons")).display');
        console.log(`  Pair buttons display: ${pairBtnDisplay}`);
        await Assert.isTrue(pairBtnDisplay === 'flex', `Pair buttons should be visible, got "${pairBtnDisplay}"`);

        results.pass('Popup Renders Basic Elements');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browser.testBridge);
    }
}

async function testPopupStatusDotReflectsConnection(browserA, browserB) {
    console.log();
    console.log('Test: Status Dot Reflects Connection');
    const { driver } = browserA;

    // Browsers are already connected from setup
    const { popupHandle, handlesBefore } = await openPopup(browserA);

    try {
        const dotColor = await queryPopup(driver,
            'return document.getElementById("statusDot")?.style.color');
        console.log(`  Status dot color: "${dotColor}"`);
        // When connected, dot should be green (CSS variable)
        await Assert.isTrue(
            dotColor.includes('--status-green') || dotColor.includes('green') || dotColor.includes('26, 159, 86') || dotColor.includes('46, 204, 113'),
            `Status dot should be green (connected), got "${dotColor}"`
        );

        results.pass('Status Dot Reflects Connection');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browserA.testBridge);
    }
}

async function testPopupAdvancedSection(browserA) {
    console.log();
    console.log('Test: Advanced Section Toggle and Content');
    const { driver } = browserA;

    const { popupHandle, handlesBefore } = await openPopup(browserA);

    try {
        // Debug content should start hidden
        const hiddenBefore = await queryPopup(driver,
            'return document.getElementById("debugContent")?.style.display');
        console.log(`  Debug content before toggle: "${hiddenBefore}"`);
        await Assert.isTrue(hiddenBefore === 'none', 'Debug content should be hidden initially');

        // Click Advanced toggle
        await queryPopup(driver, 'document.getElementById("debugToggle").click()');
        await sleep(200);

        // Debug content should be visible now
        const visibleAfter = await queryPopup(driver,
            'return document.getElementById("debugContent")?.style.display');
        console.log(`  Debug content after toggle: "${visibleAfter}"`);
        await Assert.isTrue(visibleAfter === 'block', 'Debug content should be visible after toggle');

        // aria-expanded should flip
        const expanded = await queryPopup(driver,
            'return document.getElementById("debugToggle")?.getAttribute("aria-expanded")');
        console.log(`  aria-expanded: "${expanded}"`);
        await Assert.isTrue(expanded === 'true', 'aria-expanded should be "true" after opening');

        // Let debug info populate (updateDebugInfo runs on toggle open)
        await sleep(1500);

        // Debug info should show device ID
        const debugText = await queryPopup(driver,
            'return document.getElementById("debugInfo")?.textContent');
        console.log(`  Debug info length: ${debugText?.length} chars`);
        await Assert.isTrue(debugText && debugText.includes('Device ID:'),
            'Debug info should contain "Device ID:"');
        await Assert.isTrue(debugText && debugText.includes('Online: true'),
            'Debug info should show Online: true');

        results.pass('Advanced Section Toggle and Content');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browserA.testBridge);
    }
}

async function testPopupSyncHistory(browserA, browserB) {
    console.log();
    console.log('Test: Sync History Shows Events');
    const { driver } = browserA;

    // Create a tab so there's a sync event to show
    const url = generateTestUrl('popup-sync-history');
    await browserA.testBridge.createTab(url);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    const { popupHandle, handlesBefore } = await openPopup(browserA);

    try {
        // Open Advanced
        await queryPopup(driver, 'document.getElementById("debugToggle").click()');
        await sleep(2000); // Wait for debug info + sync history to load

        const historyText = await queryPopup(driver,
            'return document.getElementById("syncHistory")?.textContent');
        console.log(`  Sync history: "${historyText?.substring(0, 100)}..."`);
        await Assert.isTrue(
            historyText && historyText !== 'No sync events yet',
            'Sync history should contain events');

        // Should show sync type labels
        const hasType = historyText.includes('merge') ||
                        historyText.includes('incremental') ||
                        historyText.includes('adopted');
        console.log(`  Contains sync type: ${hasType}`);
        await Assert.isTrue(hasType, 'Sync history should show sync type');

        results.pass('Sync History Shows Events');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browserA.testBridge);
    }
}

async function testPopupDebugInfoShowsPeer(browserA) {
    console.log();
    console.log('Test: Debug Info Shows Connected Peer');
    const { driver } = browserA;

    const { popupHandle, handlesBefore } = await openPopup(browserA);

    try {
        // Open Advanced, wait for data
        await queryPopup(driver, 'document.getElementById("debugToggle").click()');
        await sleep(2000);

        const debugText = await queryPopup(driver,
            'return document.getElementById("debugInfo")?.textContent');

        // Active peers should be > 0
        const peerMatch = debugText.match(/Active Peers: (\d+)/);
        const peerCount = peerMatch ? parseInt(peerMatch[1]) : 0;
        console.log(`  Active peers: ${peerCount}`);
        await Assert.isTrue(peerCount > 0, `Should have active peers, got ${peerCount}`);

        // Should list synced peers
        await Assert.isTrue(debugText.includes('Synced Peers:'),
            'Debug info should show "Synced Peers:"');
        await Assert.isTrue(!debugText.includes('Synced Peers: none'),
            'Synced peers should not be "none"');

        results.pass('Debug Info Shows Connected Peer');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browserA.testBridge);
    }
}

async function testPopupSyncStatusWithPairedDevice(browserA, browserB) {
    console.log();
    console.log('Test: Sync Status Line Shows Tab Count and Last Sync');
    const { driver } = browserA;

    // Pair A and B so the status line will render
    const stateA = await browserA.testBridge.getState();
    const stateB = await browserB.testBridge.getState();
    await browserA.testBridge.addPairedDevice(stateB.myDeviceId, 'Status Test B');
    await browserB.testBridge.addPairedDevice(stateA.myDeviceId, 'Status Test A');

    // Restart to get a paired connection with sync activity
    await browserA.testBridge.simulateRestart();
    await browserA.testBridge.waitForConnections(1, 30000);
    await browserA.testBridge.waitForSyncComplete(10000);

    const { popupHandle, handlesBefore } = await openPopup(browserA);

    try {
        const statusText = await queryPopup(driver,
            'return document.getElementById("syncStatus")?.textContent');
        console.log(`  Sync status: "${statusText}"`);

        // Should show tab count
        await Assert.isTrue(statusText && /\d+ tabs?/.test(statusText),
            `Sync status should show tab count, got "${statusText}"`);

        // Should show last sync info (either "just now", "Xm ago", or "Syncing...")
        await Assert.isTrue(
            statusText.includes('Last sync') || statusText.includes('Syncing'),
            `Sync status should show last sync time or syncing, got "${statusText}"`);

        results.pass('Sync Status Line Shows Tab Count and Last Sync');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browserA.testBridge);
    }
}

async function testPopupSyncStatusEmptyWhenUnpaired(browserA) {
    console.log();
    console.log('Test: Sync Status Line Empty When Unpaired');
    const { driver } = browserA;

    // Unpair all devices so pairedCount = 0
    const devices = await browserA.testBridge.getPairedDevices();
    for (const d of devices) {
        await browserA.testBridge.unpairDevice(d.peerId);
    }

    const { popupHandle, handlesBefore } = await openPopup(browserA);

    try {
        const statusText = await queryPopup(driver,
            'return document.getElementById("syncStatus")?.textContent');
        console.log(`  Sync status when unpaired: "${statusText}"`);

        await Assert.isTrue(statusText === '' || statusText === null,
            `Sync status should be empty when unpaired, got "${statusText}"`);

        results.pass('Sync Status Line Empty When Unpaired');
    } finally {
        await closePopup(driver, popupHandle, handlesBefore, browserA.testBridge);
    }
}

async function testPopupPairButtonsVisibleFromNonSyncWindow(browserA) {
    console.log();
    console.log('Test: Pair Buttons Visible From Non-Sync Window');
    const { driver } = browserA;

    // Add a fake paired device so the wrong-window banner logic triggers
    await browserA.testBridge.addPairedDevice('fake-peer-for-buttons-test', 'Fake Device');

    // Get current sync window
    const syncWinId = await browserA.testBridge.getSyncWindowId();
    console.log(`  Current sync window: ${syncWinId}`);

    const handlesBefore = await driver.getAllWindowHandles();

    // Create a second window (this is NOT the sync window)
    const newWin = await browserA.testBridge.createWindow('about:blank');
    console.log(`  Created non-sync window: ${newWin.id}`);

    // Find the new window handle by looking for the one not in the previous list.
    let newWindowHandle;
    for (let i = 0; i < 20; i++) {
        const handlesAfter = await driver.getAllWindowHandles();
        newWindowHandle = handlesAfter.find(h => !handlesBefore.includes(h));
        if (newWindowHandle) {
            break;
        }
        await sleep(250);
    }
    if (!newWindowHandle) {
        throw new Error('New window handle never appeared');
    }
    await driver.switchTo().window(newWindowHandle);

    const popupUrl = await browserA.testBridge.getPopupUrl();
    await driver.switchTo().newWindow('tab');
    const popupHandle = await driver.getWindowHandle();
    await driver.get(popupUrl);
    await sleep(2500);

    try {
        // Wrong window banner should be visible
        const bannerDisplay = await queryPopup(driver,
            'return getComputedStyle(document.getElementById("wrongWindowBanner")).display');
        console.log(`  Wrong window banner display: ${bannerDisplay}`);
        await Assert.isTrue(bannerDisplay === 'block',
            `Wrong window banner should be visible, got "${bannerDisplay}"`);

        // Pair buttons should STILL be visible (flex) even from non-sync window
        const pairBtnDisplay = await queryPopup(driver,
            'return getComputedStyle(document.getElementById("pairButtons")).display');
        console.log(`  Pair buttons display: ${pairBtnDisplay}`);
        await Assert.isTrue(pairBtnDisplay === 'flex',
            `Pair buttons should be visible from non-sync window, got "${pairBtnDisplay}"`);

        results.pass('Pair Buttons Visible From Non-Sync Window');
    } finally {
        // Close popup tab, if still open.
        try {
            await driver.switchTo().window(popupHandle);
            await driver.close();
        } catch (e) {
            // Already closed.
        }

        // Switch to any remaining window, reset the bridge.
        const remaining = await driver.getAllWindowHandles();
        await driver.switchTo().window(remaining[0]);
        await browserA.testBridge.reset();

        // Clean up the fake device
        await browserA.testBridge.unpairDevice('fake-peer-for-buttons-test');
    }
}

// Main

async function main() {
    console.log('═'.repeat(60));
    console.log('POPUP UI TESTS');
    console.log('═'.repeat(60));

    let browserA, browserB;

    try {
        console.log();
        console.log('Launching browsers...');
        browserA = await launchBrowser();
        browserB = await launchBrowser();
        console.log('✅ Both browsers launched');

        // Set up connection and initial sync
        console.log();
        console.log('Establishing connection...');
        const connA = await browserA.testBridge.waitForConnections(1, 30000);
        const connB = await browserB.testBridge.waitForConnections(1, 30000);
        await Assert.isTrue(connA && connB, 'Both browsers should connect');
        await browserA.testBridge.waitForSyncComplete(15000);
        await browserB.testBridge.waitForSyncComplete(15000);
        console.log('✅ Connected and synced');

        // Run tests -- each opens/closes popup independently
        try { await testPopupRendersBasicElements(browserA); }
        catch (e) { results.error('Popup Renders Basic Elements', e); }

        try { await testPopupStatusDotReflectsConnection(browserA, browserB); }
        catch (e) { results.error('Status Dot Reflects Connection', e); }

        try { await testPopupAdvancedSection(browserA); }
        catch (e) { results.error('Advanced Section Toggle and Content', e); }

        try { await testPopupSyncHistory(browserA, browserB); }
        catch (e) { results.error('Sync History Shows Events', e); }

        try { await testPopupDebugInfoShowsPeer(browserA); }
        catch (e) { results.error('Debug Info Shows Connected Peer', e); }

        try { await testPopupSyncStatusWithPairedDevice(browserA, browserB); }
        catch (e) { results.error('Sync Status Line Shows Tab Count and Last Sync', e); }

        try { await testPopupSyncStatusEmptyWhenUnpaired(browserA); }
        catch (e) { results.error('Sync Status Line Empty When Unpaired', e); }

        try { await testPopupPairButtonsVisibleFromNonSyncWindow(browserA); }
        catch (e) { results.error('Pair Buttons Visible From Non-Sync Window', e); }

    } catch (error) {
        results.error('Test Suite', error);
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

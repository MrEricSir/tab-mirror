#!/usr/bin/env node
/**
 * Popup UI Tests
 *
 * Opens popup.html in a tab via moz-extension:// URL and checks
 * that the UI renders correctly and reflects extension state.
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
        await sleep(500);

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

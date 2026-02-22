#!/usr/bin/env node
/**
 * Blank Tab Merge Test
 *
 * Checks that atomic merge doesn't duplicate about:blank / about:newtab tabs.
 * Bug: performAtomicMerge excluded about:blank from URL-based dedup, causing
 * N blank tabs on each side to become 2N after merge.
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep } = require('../helpers/test-helpers');

const results = new TestResults();

async function testBlankTabMergeDuplication(browserA, browserB) {
    console.log();
    console.log('Test: Blank Tab Merge Duplication');

    // Wait for initial connection and sync
    console.log('  Waiting for initial sync...');
    const connA = await browserA.testBridge.waitForConnections(1, 30000);
    const connB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connA, 'A should connect');
    await Assert.isTrue(connB, 'B should connect');
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);

    // Add extra blank tabs on both browsers
    console.log('  Creating blank tabs...');
    await browserA.testBridge.createTab('about:blank');
    await browserA.testBridge.createTab('about:blank');
    await browserB.testBridge.createTab('about:blank');
    await browserB.testBridge.createTab('about:blank');

    // Let incremental sync settle
    await sleep(3000);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);

    // Count blank tabs before forcing a re-merge
    const tabsA = await browserA.testBridge.getTabs();
    const tabsB = await browserB.testBridge.getTabs();
    const blankA = tabsA.filter(t => t.url === 'about:blank' || t.url === 'about:newtab').length;
    const blankB = tabsB.filter(t => t.url === 'about:blank' || t.url === 'about:newtab').length;
    console.log(`  A blank tabs before re-merge: ${blankA}`);
    console.log(`  B blank tabs before re-merge: ${blankB}`);
    console.log(`  A total tabs: ${tabsA.length}, B total tabs: ${tabsB.length}`);

    // Force a fresh atomic merge by simulating restart on both peers.
    // simulateRestart clears lastKnownRemoteState so isFirstSync=true,
    // which triggers atomic merge on next sync.
    console.log('  Simulating restart on both browsers...');
    await browserA.testBridge.simulateRestart();
    await browserB.testBridge.simulateRestart();

    // Wait for them to reconnect and fresh merge
    console.log('  Waiting for reconnection...');
    const reconA = await browserA.testBridge.waitForConnections(1, 30000);
    const reconB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(reconA, 'A should reconnect');
    await Assert.isTrue(reconB, 'B should reconnect');

    console.log('  Waiting for sync after re-merge...');
    await browserA.testBridge.waitForSyncComplete(15000);
    await browserB.testBridge.waitForSyncComplete(15000);

    // Count blank tabs after the merge
    const tabsA2 = await browserA.testBridge.getTabs();
    const tabsB2 = await browserB.testBridge.getTabs();
    const blankA2 = tabsA2.filter(t => t.url === 'about:blank' || t.url === 'about:newtab').length;
    const blankB2 = tabsB2.filter(t => t.url === 'about:blank' || t.url === 'about:newtab').length;
    console.log(`  A blank tabs after re-merge: ${blankA2} (was ${blankA})`);
    console.log(`  B blank tabs after re-merge: ${blankB2} (was ${blankB})`);
    console.log(`  A total tabs: ${tabsA2.length}, B total tabs: ${tabsB2.length}`);

    // Blank tab count shouldn't go up after merge
    await Assert.isTrue(blankA2 <= blankA, `A: blank tabs grew from ${blankA} to ${blankA2}`);
    await Assert.isTrue(blankB2 <= blankB, `B: blank tabs grew from ${blankB} to ${blankB2}`);

    // Both should have the same tab count
    await Assert.isTrue(tabsA2.length === tabsB2.length,
        `Tab counts should match: A=${tabsA2.length}, B=${tabsB2.length}`);

    results.pass('Blank Tab Merge Duplication');
}

async function main() {
    console.log('═'.repeat(60));
    console.log('BLANK TAB MERGE TESTS');
    console.log('═'.repeat(60));

    let browserA, browserB;

    try {
        console.log();
        console.log('Launching browsers...');
        browserA = await launchBrowser();
        browserB = await launchBrowser();
        console.log('✅ Both browsers launched');

        await testBlankTabMergeDuplication(browserA, browserB);

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

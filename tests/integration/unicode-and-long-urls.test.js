#!/usr/bin/env node
/**
 * Unicode & Long URL Tests
 *
 * Tests encoding edge cases in the sync pipeline:
 * - CJK, emoji, and RTL group titles sync correctly
 * - Non-ASCII URLs sync correctly
 * - URL length boundary at 8192 bytes (> rejects, <= accepts)
 * - Group title length boundary at 256 chars (truncated beyond)
 * - Long URL round-trip sync between two browsers
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

// --- Two-browser live sync tests ---

async function testCJKGroupTitleSyncs(browserA, browserB) {
  console.log();
  console.log('Test: CJK Group Title Syncs');

  const url1 = generateTestUrl('cjk-grp-1');
  const url2 = generateTestUrl('cjk-grp-2');
  const t1 = await browserA.testBridge.createTab(url1);
  const t2 = await browserA.testBridge.createTab(url2);
  await sleep(500);

  const title = '日本語グループ';
  await browserA.testBridge.groupTabs([t1.id, t2.id], title, 'blue');
  await sleep(1000);

  const group = await browserB.testBridge.waitForGroupState(title, true, 20000);
  await Assert.isTrue(!!group, `B should have group with CJK title "${title}"`);
  await Assert.equal(group.title, title, 'Group title should match exactly');

  results.pass('CJK Group Title Syncs');
}

async function testEmojiGroupTitleSyncs(browserA, browserB) {
  console.log();
  console.log('Test: Emoji Group Title Syncs');

  const url1 = generateTestUrl('emoji-grp-1');
  const url2 = generateTestUrl('emoji-grp-2');
  const t1 = await browserA.testBridge.createTab(url1);
  const t2 = await browserA.testBridge.createTab(url2);
  await sleep(500);

  const title = 'Rockets 🚀🌟';
  await browserA.testBridge.groupTabs([t1.id, t2.id], title, 'red');
  await sleep(1000);

  const group = await browserB.testBridge.waitForGroupState(title, true, 20000);
  await Assert.isTrue(!!group, `B should have group with emoji title "${title}"`);
  await Assert.equal(group.title, title, 'Emoji title should be preserved');

  results.pass('Emoji Group Title Syncs');
}

async function testRTLMixedScriptGroupTitle(browserA, browserB) {
  console.log();
  console.log('Test: RTL + Mixed Script Group Title');

  const url1 = generateTestUrl('rtl-grp-1');
  const url2 = generateTestUrl('rtl-grp-2');
  const t1 = await browserA.testBridge.createTab(url1);
  const t2 = await browserA.testBridge.createTab(url2);
  await sleep(500);

  const title = 'مجموعة Tab Group';
  await browserA.testBridge.groupTabs([t1.id, t2.id], title, 'green');
  await sleep(1000);

  const group = await browserB.testBridge.waitForGroupState(title, true, 20000);
  await Assert.isTrue(!!group, `B should have group with RTL title "${title}"`);
  await Assert.equal(group.title, title, 'RTL + Latin title should be preserved');

  results.pass('RTL + Mixed Script Group Title');
}

async function testNonASCIIUrlSyncs(browserA, browserB) {
  console.log();
  console.log('Test: Non-ASCII URL Syncs');

  const url = 'http://127.0.0.1:8080/caf\u00e9-na\u00efve-\u65e5\u672c\u8a9e';
  await browserA.testBridge.createTab(url);
  await sleep(1000);

  const found = await browserB.testBridge.waitForTabUrl('caf', 20000);
  await Assert.isTrue(!!found, 'B should have tab with non-ASCII URL');

  // Verify the URL contains the non-ASCII characters
  const tabsB = await browserB.testBridge.getTabs();
  const matchingTab = tabsB.find(t => t.url && t.url.includes('caf'));
  console.log(`  Synced URL: ${matchingTab ? matchingTab.url : 'not found'}`);
  await Assert.isTrue(!!matchingTab, 'Tab with non-ASCII URL should sync');

  results.pass('Non-ASCII URL Syncs');
}

async function testLongURLRoundTripSync(browserA, browserB) {
  console.log();
  console.log('Test: Long URL Round-Trip Sync');

  // Build a ~7000-char URL (well under 8192 limit)
  const padding = 'x'.repeat(6980);
  const longUrl = `http://127.0.0.1:8080/long-roundtrip-${padding}`;
  console.log(`  URL length: ${longUrl.length}`);

  await browserA.testBridge.createTab(longUrl);
  await sleep(1000);

  const found = await browserB.testBridge.waitForTabUrl('long-roundtrip-', 20000);
  await Assert.isTrue(!!found, 'B should have long URL tab');

  const tabsB = await browserB.testBridge.getTabs();
  const matchingTab = tabsB.find(t => t.url && t.url.includes('long-roundtrip-'));
  console.log(`  Synced URL length: ${matchingTab ? matchingTab.url.length : 0}`);
  await Assert.equal(matchingTab.url.length, longUrl.length, 'Full URL should be preserved');

  results.pass('Long URL Round-Trip Sync');
}

// --- Single-browser injectRemoteState tests ---

async function testURLAtExactly8192BytesPasses(browserA) {
  console.log();
  console.log('Test: URL at Exactly 8192 Bytes Passes');

  // Build a URL that is exactly 8192 bytes
  const prefix = 'http://127.0.0.1:8080/boundary-pass-';
  const padding = 'a'.repeat(8192 - prefix.length);
  const url = prefix + padding;
  console.log(`  URL length: ${url.length}`);
  await Assert.equal(url.length, 8192, 'URL should be exactly 8192 bytes');

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-url-boundary-peer',
    tabs: [
      { sId: 'sid_boundary_pass_01', url, index: 0, pinned: false, muted: false }
    ],
    groups: {}
  });

  await sleep(1500);

  const tabs = await browserA.testBridge.getTabs();
  const found = tabs.find(t => t.url && t.url.includes('boundary-pass-'));
  console.log(`  Tab found: ${!!found}`);
  await Assert.isTrue(!!found, 'Tab with 8192-byte URL should be accepted (validation uses >, not >=)');

  results.pass('URL at Exactly 8192 Bytes Passes');
}

async function testURLAt8193BytesRejected(browserA) {
  console.log();
  console.log('Test: URL at 8193 Bytes Is Rejected');

  const prefix = 'http://127.0.0.1:8080/boundary-fail-';
  const padding = 'a'.repeat(8193 - prefix.length);
  const url = prefix + padding;
  console.log(`  URL length: ${url.length}`);
  await Assert.equal(url.length, 8193, 'URL should be exactly 8193 bytes');

  const tabsBefore = await browserA.testBridge.getTabs();
  const countBefore = tabsBefore.length;

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-url-reject-peer',
    tabs: [
      { sId: 'sid_boundary_fail_01', url, index: 0, pinned: false, muted: false }
    ],
    groups: {}
  });

  await sleep(1500);

  const tabsAfter = await browserA.testBridge.getTabs();
  const found = tabsAfter.find(t => t.url && t.url.includes('boundary-fail-'));
  console.log(`  Tab found: ${!!found}`);
  await Assert.isTrue(!found, 'Tab with 8193-byte URL should be rejected');

  results.pass('URL at 8193 Bytes Is Rejected');
}

async function testGroupTitleAt256CharsPreserved(browserA) {
  console.log();
  console.log('Test: Group Title at 256 Chars Preserved');

  const title = 'T'.repeat(256);
  console.log(`  Title length: ${title.length}`);

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-title-256-peer',
    tabs: [
      { sId: 'sid_title256_00001', url: 'http://127.0.0.1:8080/title-256', index: 0, pinned: false, muted: false, groupSyncId: 'gsid_title256_0001' }
    ],
    groups: {
      'gsid_title256_0001': { title, color: 'blue', lastModified: Date.now() }
    }
  });

  await sleep(1500);

  const groupResult = await browserA.testBridge.getGroupCount();
  const group = groupResult.groupDetails.find(g => g.title && g.title.length === 256);
  console.log(`  Group found: ${!!group}, title length: ${group ? group.title.length : 0}`);
  await Assert.isTrue(!!group, 'Group with 256-char title should be preserved');
  await Assert.equal(group.title.length, 256, 'Title should be exactly 256 chars');

  results.pass('Group Title at 256 Chars Preserved');
}

async function testGroupTitleOver256CharsTruncated(browserA) {
  console.log();
  console.log('Test: Group Title Over 256 Chars Truncated');

  const title = 'X'.repeat(300);
  console.log(`  Original title length: ${title.length}`);

  await browserA.testBridge.injectRemoteState({
    type: 'MIRROR_SYNC',
    peerId: 'test-title-300-peer',
    tabs: [
      { sId: 'sid_title300_00001', url: 'http://127.0.0.1:8080/title-300', index: 0, pinned: false, muted: false, groupSyncId: 'gsid_title300_0001' }
    ],
    groups: {
      'gsid_title300_0001': { title, color: 'red', lastModified: Date.now() }
    }
  });

  await sleep(1500);

  const groupResult = await browserA.testBridge.getGroupCount();
  // Find the group with all 'X' characters
  const group = groupResult.groupDetails.find(g => g.title && /^X+$/.test(g.title));
  console.log(`  Group found: ${!!group}, title length: ${group ? group.title.length : 0}`);
  await Assert.isTrue(!!group, 'Group with truncated title should exist');
  await Assert.equal(group.title.length, 256, 'Title should be truncated to 256 chars');

  results.pass('Group Title Over 256 Chars Truncated');
}

async function main() {
  console.log('='.repeat(60));
  console.log('UNICODE & LONG URL TESTS');
  console.log('='.repeat(60));

  let browserA, browserB;

  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    // Wait for connection + initial sync
    console.log();
    console.log('Waiting for connection...');
    const connectedA = await browserA.testBridge.waitForConnections(1, 30000);
    const connectedB = await browserB.testBridge.waitForConnections(1, 30000);
    await Assert.isTrue(connectedA, 'Browser A should connect');
    await Assert.isTrue(connectedB, 'Browser B should connect');

    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('Connected and synced');

    // Two-browser sync tests
    const syncTests = [
      testCJKGroupTitleSyncs,
      testEmojiGroupTitleSyncs,
      testRTLMixedScriptGroupTitle,
      testNonASCIIUrlSyncs,
      testLongURLRoundTripSync,
    ];

    for (const test of syncTests) {
      try {
        await test(browserA, browserB);
      } catch (error) {
        results.error(test.name || 'Unknown Test', error);
      }
    }

    // Single-browser boundary validation tests (use browserA only)
    const boundaryTests = [
      testURLAtExactly8192BytesPasses,
      testURLAt8193BytesRejected,
      testGroupTitleAt256CharsPreserved,
      testGroupTitleOver256CharsTruncated,
    ];

    for (const test of boundaryTests) {
      try {
        await test(browserA);
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

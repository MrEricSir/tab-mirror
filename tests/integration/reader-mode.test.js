#!/usr/bin/env node
/**
 * Reader Mode URL Normalization Tests
 *
 * Verifies that Firefox reader mode URLs (about:reader?url=...) are handled
 * correctly by the extension's normalization pipeline:
 *
 * 1. normalizeUrl() decodes about:reader URLs to their inner URL
 * 2. captureLocalState() applies normalizeUrl to all tab URLs before syncing
 *
 * Note: Firefox blocks creating about:reader tabs via browser.tabs.create(),
 * so we can't create real reader mode tabs in tests. Instead we verify:
 * - normalizeUrl works correctly in the extension runtime (deployed code)
 * - captureLocalState applies normalization (pipeline is connected)
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testNormalizeUrlInExtension(browserA) {
  console.log();
  console.log('Test: normalizeUrl Handles Reader URLs in Extension Runtime');

  // Test encoded about:reader URL
  const encoded = 'about:reader?url=https%3A%2F%2Fexample.com%2Farticle';
  const decodedResult = await browserA.testBridge.testNormalizeUrl(encoded);
  console.log(`  Encoded reader URL -> ${decodedResult}`);
  await Assert.equal(decodedResult, 'https://example.com/article',
    'Should decode encoded about:reader URL to inner URL');

  // Test non-encoded about:reader URL
  const nonEncoded = 'about:reader?url=https://example.com/page';
  const nonEncodedResult = await browserA.testBridge.testNormalizeUrl(nonEncoded);
  console.log(`  Non-encoded reader URL -> ${nonEncodedResult}`);
  await Assert.equal(nonEncodedResult, 'https://example.com/page',
    'Should pass through non-encoded about:reader URL');

  // Test about:newtab normalization (existing behavior)
  const newtabResult = await browserA.testBridge.testNormalizeUrl('about:newtab');
  console.log(`  about:newtab -> ${newtabResult}`);
  await Assert.equal(newtabResult, 'about:blank',
    'Should normalize about:newtab to about:blank');

  // Test normal URL passes through unchanged
  const normalUrl = 'https://www.mozilla.org/';
  const normalResult = await browserA.testBridge.testNormalizeUrl(normalUrl);
  console.log(`  Normal URL -> ${normalResult}`);
  await Assert.equal(normalResult, normalUrl,
    'Should pass through normal URLs unchanged');

  // Test malformed encoding returns original
  const malformed = 'about:reader?url=%ZZ%invalid';
  const malformedResult = await browserA.testBridge.testNormalizeUrl(malformed);
  console.log(`  Malformed reader URL -> ${malformedResult}`);
  await Assert.equal(malformedResult, malformed,
    'Should return original URL for malformed encoding');

  results.pass('normalizeUrl Handles Reader URLs in Extension Runtime');
}

async function testCapturedStateAppliesNormalization(browserA) {
  console.log();
  console.log('Test: captureLocalState Applies URL Normalization');

  // Create a normal tab to verify captureLocalState returns tabs
  const testUrl = generateTestUrl('capture-norm-test');
  await browserA.testBridge.createTab(testUrl);
  await sleep(1000);

  // Get the captured state (what would be broadcast to peers)
  const captured = await browserA.testBridge.getCapturedState();
  const capturedUrls = captured.tabs.map(t => t.url);
  console.log(`  Captured ${captured.tabs.length} tabs`);

  // Our test tab should appear with its original URL (no normalization needed)
  const hasTestUrl = capturedUrls.some(u => u.includes('capture-norm-test'));
  console.log(`  Test URL in captured state: ${hasTestUrl}`);
  await Assert.isTrue(hasTestUrl, 'Captured state should include our test tab');

  // No about:reader or about:newtab URLs should appear - they should all be normalized
  const hasReaderUrl = capturedUrls.some(u => u.startsWith('about:reader'));
  const hasNewtabUrl = capturedUrls.some(u => u === 'about:newtab');
  console.log(`  Has about:reader URLs: ${hasReaderUrl}`);
  console.log(`  Has about:newtab URLs: ${hasNewtabUrl}`);
  await Assert.isTrue(!hasReaderUrl, 'Captured state should not contain about:reader URLs');
  await Assert.isTrue(!hasNewtabUrl, 'Captured state should not contain about:newtab URLs');

  // All captured URLs should be syncable (http/https or about:blank)
  for (const url of capturedUrls) {
    const isSyncable = url.startsWith('http:') || url.startsWith('https:') || url === 'about:blank';
    if (!isSyncable) {
      console.log(`  Non-syncable URL found: ${url}`);
    }
    await Assert.isTrue(isSyncable, `All captured URLs should be syncable, found: ${url}`);
  }

  console.log(`  All ${capturedUrls.length} captured URLs are syncable`);
  results.pass('captureLocalState Applies URL Normalization');
}

async function main() {
  console.log('='.repeat(60));
  console.log('READER MODE URL NORMALIZATION TESTS');
  console.log('='.repeat(60));

  let browserA, browserB;
  try {
    console.log();
    console.log('Launching browsers...');
    browserA = await launchBrowser();
    browserB = await launchBrowser();
    console.log('Browsers launched');

    // Wait for connection and initial sync
    await browserA.testBridge.waitForConnections(1, 30000);
    await browserB.testBridge.waitForConnections(1, 30000);
    await browserA.testBridge.waitForSyncComplete(10000);
    await browserB.testBridge.waitForSyncComplete(10000);
    console.log('Connected and synced');

    await testNormalizeUrlInExtension(browserA);
    await testCapturedStateAppliesNormalization(browserA);
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

main();

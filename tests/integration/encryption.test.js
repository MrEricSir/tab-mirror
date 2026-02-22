#!/usr/bin/env node
/**
 * Encryption Tests
 *
 * Checks that E2E encryption (AES-256-GCM) works:
 * - Encrypt/decrypt roundtrip
 * - Tamper detection (GCM auth tag)
 * - Wrong key detection
 */

const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep } = require('../helpers/test-helpers');

const results = new TestResults();

async function testEncryptionRoundtrip(browser) {
  console.log();
  console.log('Test: Encryption Roundtrip');

  const result = await browser.testBridge.testEncryption();
  console.log(`  Result: ${JSON.stringify(result)}`);

  await Assert.isTrue(result.encrypted, 'Should produce ciphertext');
  await Assert.isTrue(result.decrypted, 'Should decrypt to valid MIRROR_SYNC');
  await Assert.isTrue(result.tabsMatch, 'Decrypted tabs should match original');
  await Assert.isTrue(result.tamperDetected, 'Should detect tampered ciphertext');
  await Assert.isTrue(result.wrongKeyDetected, 'Should detect wrong decryption key');

  results.pass('Encryption Roundtrip');
}

async function main() {
  console.log('═'.repeat(60));
  console.log('ENCRYPTION TESTS');
  console.log('═'.repeat(60));

  let browser;

  try {
    console.log();
    console.log('Launching browser...');
    browser = await launchBrowser();
    console.log('✅ Browser launched');

    await testEncryptionRoundtrip(browser);

  } catch (error) {
    results.error('Test Suite', error);
  } finally {
    console.log();
    console.log('Cleaning up...');
    await cleanupBrowser(browser);
  }

  results.summary();
  process.exit(results.exitCode());
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

main();

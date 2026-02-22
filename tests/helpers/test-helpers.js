/**
 * Test Helpers - Common utilities for Tab Mirror tests
 *
 * Re-exports generic utilities from selenium-webext-bridge and adds
 * Tab Mirror-specific browser launch configuration.
 */

const fs = require('fs');
const path = require('path');

const { launchBrowser: baseLaunchBrowser, cleanupBrowser, TestBridge, sleep, generateTestUrl, TabUtils, Assert, TestResults } = require('selenium-webext-bridge');
const { TabMirrorBridge } = require('./tab-mirror-bridge');

// Discover the built extension zip instead of hardcoding the version
const ARTIFACTS_DIR = path.resolve(__dirname, '../../web-ext-artifacts/test');
const TAB_MIRROR_EXT = fs.readdirSync(ARTIFACTS_DIR)
  .filter(f => f.startsWith('tab_mirror-') && f.endsWith('.zip'))
  .map(f => path.join(ARTIFACTS_DIR, f))[0];

/**
 * Launch Firefox with Tab Mirror and Test Bridge extensions
 * @param {Object} options - Config options (passed through to baseLaunchBrowser)
 * @returns {Object} { driver, testBridge, profilePath }
 */
async function launchBrowser(options = {}) {
  return baseLaunchBrowser({
    extensions: [TAB_MIRROR_EXT],
    BridgeClass: TabMirrorBridge,
    ...options
  });
}

module.exports = {
  launchBrowser,
  cleanupBrowser,
  TestBridge,
  TestResults,
  TabUtils,
  Assert,
  sleep,
  generateTestUrl
};

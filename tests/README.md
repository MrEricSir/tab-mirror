# Tab Mirror - Test Suite

Integration tests for Tab Mirror using Selenium WebDriver, Firefox, and the `selenium-webext-bridge` npm package.

## Prerequisites

- Node.js >= 16
- Firefox installed and on PATH:
  ```bash
  export PATH="/Applications/Firefox.app/Contents/MacOS:$PATH"
  ```
- Dependencies installed:
  ```bash
  npm install
  ```

## Structure

```
tests/
├── helpers/
│   ├── test-helpers.js          # Re-exports from selenium-webext-bridge with Tab Mirror config
│   └── tab-mirror-bridge.js     # TabMirrorBridge class (Tab Mirror-specific commands)
├── integration/
│   ├── basic-sync.test.js
│   ├── blank-tab-merge.test.js
│   ├── broadcast-retry.test.js
│   ├── concurrent-sync.test.js
│   ├── connectivity.test.js
│   ├── connection-failure.test.js
│   ├── edge-cases.test.js
│   ├── encryption.test.js
│   ├── initial-group-sync.test.js
│   ├── mesh-scalability.test.js
│   ├── multi-instance.test.js
│   ├── notifications.test.js
│   ├── popup-ui.test.js
│   ├── stale-peer.test.js
│   ├── stress.test.js
│   ├── sync-window.test.js
│   ├── tab-operations.test.js
│   └── validation.test.js
├── run-all.js                   # Discovers all .test.js files, runs sequentially
└── run-with-server.js           # Runs a single test file with PeerJS + HTTP servers
```

## Running Tests

### All suites

```bash
npm test
```

This builds the test extension, starts PeerJS and HTTP servers, runs every `*.test.js` file sequentially (restarting the PeerJS server between suites to clear stale peers), and prints a summary.

### Individual suites

Each suite has an npm script that builds, starts servers, runs the suite, and tears down:

| Script | Suite file | What it covers |
|---|---|---|
| `npm run test:basic` | `basic-sync.test.js` | Tab create, close, navigate, reload, mute sync between 2 browsers |
| `npm run test:ops` | `tab-operations.test.js` | Ordering, pinning, groups, pairing, auth, privileged tabs (28 tests) |
| `npm run test:groups` | `initial-group-sync.test.js` | Groups not duplicated on initial sync |
| `npm run test:window` | `sync-window.test.js` | Sync window selection, non-sync window isolation, fallback adoption |
| `npm run test:multi` | `multi-instance.test.js` | 3-4 browser mesh, chain propagation, group sync |
| `npm run test:stress` | `stress.test.js` | 20+ tabs, rapid changes, broadcast serialization |
| `npm run test:stale` | `stale-peer.test.js` | Stale detection, ping/pong keepalive, reconnection |
| `npm run test:edge` | `edge-cases.test.js` | Private windows, extension reload, group name conflicts |
| `npm run test:validation` | `validation.test.js` | Sync ID format, dedup, invalid data filtering, stale tab errors |
| `npm run test:connection` | `connection-failure.test.js` | Graceful degradation when server is unavailable |
| `npm run test:connectivity` | `connectivity.test.js` | Discovery, initial merge, reconnection, duplicate URLs, restart |
| `npm run test:broadcast` | `broadcast-retry.test.js` | Disconnect recovery and reconnection |
| `npm run test:encryption` | `encryption.test.js` | AES-256-GCM encrypt/decrypt roundtrip, tamper detection, wrong key |
| `npm run test:concurrent` | `concurrent-sync.test.js` | Sync queue mechanics and concurrent syncs from multiple peers |
| `npm run test:blank` | `blank-tab-merge.test.js` | Blank tab deduplication during merge |
| `npm run test:popup` | `popup-ui.test.js` | Popup renders, status dot, advanced section, sync history |

Two suites have no npm shortcut and must be run directly:

```bash
npm run build:test && node tests/run-with-server.js tests/integration/mesh-scalability.test.js
npm run build:test && node tests/run-with-server.js tests/integration/notifications.test.js
```

- **mesh-scalability.test.js** -- 5-peer mesh formation, propagation, simultaneous changes
- **notifications.test.js** -- Pairing notifications, no duplicates, reset after restart

## Test Infrastructure

Tests use the `selenium-webext-bridge` npm package (a standalone package, not a local directory). It provides the Selenium/Firefox launcher, test bridge extension, HTTP server for test pages, and generic helpers (`TabUtils`, `Assert`, `TestResults`, `sleep`, `generateTestUrl`).

### How the bridge works

1. `launchBrowser()` starts Firefox with two extensions: the Tab Mirror test build (`tab_mirror-0.1.0.zip`) and the test bridge extension (bundled in `selenium-webext-bridge`).
2. The test bridge extension injects a page-level API that Selenium calls via `executeScript()`.
3. The bridge relays commands to Tab Mirror through `browser.runtime.sendMessageExternal` using the test extension ID `tab-mirror@test.local`.

### Servers

- **PeerJS server** (port 9000) -- local signaling server for WebRTC peer discovery (`test-server.js` in project root, uses the `peer` npm package with `allow_discovery: true`).
- **HTTP server** (port 8080) -- serves simple test pages for bridge initialization (provided by `selenium-webext-bridge`).

Both `run-all.js` and `run-with-server.js` manage server lifecycle automatically.

## Helper API Reference

### test-helpers.js

Re-exports from `selenium-webext-bridge` plus a pre-configured `launchBrowser`:

```javascript
const {
  launchBrowser,    // Launches Firefox with Tab Mirror + bridge extensions
  cleanupBrowser,   // Graceful browser teardown
  TestBridge,       // Base bridge class (rarely used directly)
  TestResults,      // Pass/fail/error tracking and summary printing
  TabUtils,         // Tab manipulation (openTab, closeCurrentTab, getTabCount, switchToTab)
  Assert,           // Assertions (equal, greaterThan, includes, isTrue)
  sleep,            // Promise-based delay
  generateTestUrl   // Generate unique http://localhost:8080 test URLs
} = require('./helpers/test-helpers');
```

### TabMirrorBridge

The `TabMirrorBridge` class (in `tab-mirror-bridge.js`) extends `TestBridge` with Tab Mirror-specific commands. Every `launchBrowser()` call returns `{ driver, testBridge }` where `testBridge` is a `TabMirrorBridge` instance.

**State inspection:**

| Method | Returns |
|---|---|
| `getState()` | Full extension state (connections, syncCounter, myDeviceId, syncWindowId, etc.) |
| `getLogs()` | Console logs captured from the Tab Mirror background script |
| `getDeviceId()` | This browser's peer ID |
| `getConnectionCount()` | Number of connected peers |
| `getSyncedPeers()` | Set of peer IDs that have completed sync |
| `getSyncWindowId()` | The window ID designated for sync |
| `getGroupCount()` | `{ groups, groupedTabs, groupDetails }` |
| `getPairedDevices()` | List of paired devices |
| `getNotificationLog()` | Notifications fired this session |
| `getBroadcastStats()` | Broadcast send/receive statistics |
| `getLastMessageTimes()` | Timestamps of last messages per peer |
| `getPopupUrl()` | `moz-extension://` URL for popup.html |

**Actions:**

| Method | What it does |
|---|---|
| `triggerSync()` | Force a sync broadcast |
| `simulateRestart()` | Wipes in-memory state and reconnects (keeps syncedPeers) |
| `forceReplaceLocalState()` | Runs replaceLocalState with current state; returns before/after counts |
| `injectRemoteState(remoteState)` | Injects arbitrary remote state for validation testing |
| `addPairedDevice(peerId, name)` | Pair a device |
| `unpairDevice(peerId)` | Remove a paired device |
| `disconnectPeer(peerId)` | Force-disconnect a specific peer |
| `muteOutgoing(muted)` | Suppress outgoing sync broadcasts |
| `setStalePeerTimeout(timeout)` | Override stale peer detection timeout |
| `createStaleMapping(syncId, tabId)` | Create a stale syncId-to-tabId mapping for testing |
| `createPrivateWindow(url)` | Open a private browsing window |
| `testEncryption()` | Run encryption roundtrip test inside the extension |
| `testSyncQueue()` | Exercise the sync queue from inside the extension |
| `resetBroadcastStats()` | Reset broadcast counters |
| `runHealthCheck()` | Run internal health check |

**Waiters:**

| Method | What it does |
|---|---|
| `waitForConnections(count, timeout)` | Poll until `count` peers are connected (default 10s timeout) |
| `waitForSyncComplete(timeout)` | Poll until syncCounter stabilizes (default 10s timeout) |
| `waitForGroupState(title, shouldExist, timeout)` | Wait for a named group to appear or disappear |

## Writing New Tests

### Template

```javascript
#!/usr/bin/env node
const { launchBrowser, cleanupBrowser, TestResults, Assert, sleep, generateTestUrl } = require('../helpers/test-helpers');

const results = new TestResults();

async function testSomething(browserA, browserB) {
  console.log('\nTest: Something works');

  const state = await browserA.testBridge.getState();
  await Assert.isTrue(state.connections.length > 0, 'Should be connected');

  results.pass('Something works');
}

async function main() {
  console.log('='.repeat(60));
  console.log('MY TEST SUITE');
  console.log('='.repeat(60));

  let browserA, browserB;

  try {
    browserA = await launchBrowser();
    browserB = await launchBrowser();

    // Wait for peers to discover each other
    await browserA.testBridge.waitForConnections(1, 15000);
    await browserB.testBridge.waitForConnections(1, 15000);

    // Wait for initial sync to settle
    await browserA.testBridge.waitForSyncComplete();

    await testSomething(browserA, browserB);

  } catch (error) {
    results.error('Test Suite', error);
  } finally {
    if (browserA) await cleanupBrowser(browserA);
    if (browserB) await cleanupBrowser(browserB);
  }

  results.summary();
  process.exit(results.exitCode());
}

main();
```

### Guidelines

- Use `testBridge.createTab()` instead of Selenium `switchTo().newWindow()` when sync may interfere with the browsing context (e.g., right after browser launch).
- Use `generateTestUrl('label')` for unique test page URLs served by the HTTP server.
- Always `waitForConnections` and `waitForSyncComplete` before asserting on synced state.
- Clean up browsers in a `finally` block using `cleanupBrowser()`.
- Use `Assert` methods so failures produce clear messages in the test output.

## Troubleshooting

### Firefox not found

Make sure Firefox is on your PATH:

```bash
export PATH="/Applications/Firefox.app/Contents/MacOS:$PATH"
which firefox
```

### Extensions not loading

Rebuild the test extension:

```bash
npm run build:test
```

This produces `web-ext-artifacts/test/tab_mirror-0.1.0.zip`.

### Peers not connecting

- Verify the PeerJS server is running on port 9000 (the test runners start it automatically).
- Check logs with `testBridge.getLogs()` for connection errors.
- Make sure you built with `npm run build:test` (injects `TEST_MODE=true` so the extension connects to `localhost:9000` instead of the production PeerJS server).

### Tests timing out

- Increase timeout values in `waitForConnections()` or `waitForSyncComplete()`.
- Add `sleep()` calls after actions that trigger async sync.
- Check that `geckodriver` processes from previous runs are not lingering (`pgrep geckodriver`).

### Test bridge not responding

- The bridge only works on regular web pages, not `about:` pages.
- If context is lost (tab closed during sync), `TabMirrorBridge.getState()` auto-recovers by reinitializing.

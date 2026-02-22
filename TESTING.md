# Testing

## Prerequisites

- Node.js
- Firefox installed and on PATH:
  ```bash
  export PATH="/Applications/Firefox.app/Contents/MacOS:$PATH"
  ```
- Dependencies installed:
  ```bash
  npm install
  ```

## Automated Tests

Multiple integration suites thoroughly test the extension with Selenium and multiple Firefox instances.

### Run all tests

```bash
npm test
```

This builds the test extension, starts local PeerJS and HTTP servers, runs every suite sequentially, and prints a summary.

For CI/CD environments the tests can be run headlessly:

```bash
HEADLESS=1 npm test
```

### Run individual suites

| Script | What it covers |
|---|---|
| `npm run test:basic` | Tab create, close, navigate, reload, mute sync |
| `npm run test:ops` | Ordering, pinning, groups, pairing, auth (28 tests) |
| `npm run test:groups` | Group deduplication on initial sync |
| `npm run test:window` | Sync window selection, isolation, fallback adoption |
| `npm run test:multi` | 3-4 browser mesh, chain propagation |
| `npm run test:stress` | 20+ tabs, rapid changes, broadcast serialization |
| `npm run test:stale` | Stale detection, ping/pong keepalive, reconnection |
| `npm run test:edge` | Private windows, extension reload, group name conflicts |
| `npm run test:validation` | Sync ID format, dedup, invalid data filtering |
| `npm run test:connection` | Graceful degradation when server is unavailable |
| `npm run test:connectivity` | Discovery, initial merge, reconnection, restart |
| `npm run test:broadcast` | Disconnect recovery and reconnection |
| `npm run test:encryption` | AES-256-GCM roundtrip, tamper detection, wrong key |
| `npm run test:concurrent` | Sync queue mechanics, concurrent multi-peer syncs |
| `npm run test:blank` | Blank tab deduplication during merge |
| `npm run test:popup` | Popup renders, status dot, advanced section |

Two suites have no npm shortcut:

```bash
npm run build:test && node tests/run-with-server.js tests/integration/mesh-scalability.test.js
npm run build:test && node tests/run-with-server.js tests/integration/notifications.test.js
```

### Linting

```bash
npm run lint
```

See [tests/README.md](tests/README.md) for test infrastructure details, helper API reference, and how to write new tests.

## Manual Tests

These tests cannot be automated: manual testing is required.

### Setup

1. **Start local test server**
   ```bash
   npm run server:test
   ```

2. **Build test extension** (in separate terminal)
   ```bash
   npm run build:test
   ```

3. **Load in two Firefox instances**:
   - Open two Firefox instances with separate profiles.
     - Command line: `firefox -P MyProfileName -no-remote`
   - In each window:
     - Go to `about:debugging#/runtime/this-firefox`
     - Click "Load Temporary Add-on"
     - Select `web-ext-artifacts/test/tab_mirror-0.1.0.zip`

### Stability Test

Long-running soak test to check for memory leaks and degraded sync over time.

1. Leave both instances connected for 1+ hour
2. Periodically make changes (open/close/navigate tabs)
3. Verify sync continues to work throughout
4. Check for memory leaks (extensions should stay under 50MB)
   - In `about:memory`, click "Measure" and look for the extension's resident set

### Production Build Test

Production builds use pairing codes and the public `0.peerjs.com` signaling server, which the automated tests cannot exercise.

1. Build:
   ```bash
   npm run build:prod
   ```
2. Load `web-ext-artifacts/production/tab_mirror-0.1.0.zip` in Firefox on two devices
3. On Device A, open the popup and click **Pair New Device** -- note the code
4. On Device B, click **Join Device** and enter the code
5. Verify both devices show each other as "Connected" in the popup
6. Open/close/navigate tabs and verify sync works

**Note**: The public `0.peerjs.com` server may be unreliable. See [SERVER_SETUP.md](SERVER_SETUP.md) for deploying your own server.

## Troubleshooting

### Firefox not found

On MacOS:

```bash
export PATH="/Applications/Firefox.app/Contents/MacOS:$PATH"
which firefox
```

### Peers not connecting

- Verify the PeerJS server is running on port 9000 (test runners start it automatically)
- Check logs with `testBridge.getLogs()` for connection errors
- Make sure you built with `npm run build:test` (not `build:prod`)

### Test timeout

- Increase timeout values in `waitForConnections()` or `waitForSyncComplete()`
- Check that `geckodriver` processes from previous runs are not lingering (`pgrep geckodriver`)

### Manual test: no connection after 60 seconds

```bash
curl http://localhost:9000/myapp
# Should return: "Not found"
```

Check the Browser Console (Ctrl+Shift+J / Cmd+Option+J) for error messages. Common issues: server not started, wrong build, firewall blocking localhost.

# ![logo](https://raw.githubusercontent.com/MrEricSir/tab-mirror/refs/heads/main/src/icons/icon-light.svg) Tab Mirror
## Firefox Extension
[![Test Tab Mirror Extension](https://github.com/MrEricSir/tab-mirror/actions/workflows/test.yml/badge.svg)](https://github.com/MrEricSir/tab-mirror/actions/workflows/test.yml)

Synchronizes tabs across multiple Firefox instances via PeerJS.

## Features

- **Immediate sync**: Tabs appear instantly across all connected devices
- **Peer to peer**: No account required, no server storing your data, no tracking
- **Tab state sync**: Pinned tabs, tab groups, and mute/unmute
- **Sync window**: Designate one window per device for syncing (does not work in private windows by design)
- **E2E encryption**: AES-256-GCM on top of WebRTC's built-in DTLS

Does not sync history, cookies, POST requests, or passwords. Works only with desktop Firefox.

## Installation

**Note**: Not yet available on Mozilla Add-ons. For now, install from source (see Development below).

### Setup

1. Install the extension on all devices
2. On one device, click **Pair** in the popup to generate a code. On the other device, click **Join** and enter the code.
3. The extension syncs tabs in one designated window per device.

## Development

```bash
git clone https://github.com/MrEricSir/tab-mirror.git
cd tab-mirror
npm install
npm test
```

### Building

```bash
npm run build:prod   # Production build
npm run build:test   # Test build (includes Test Bridge support)
npm run build        # Build both
```

### Testing

```bash
npm test             # Run all 20 integration test suites
npm run lint         # Extension linting
```

See [TESTING.md](TESTING.md) for individual test suites, manual testing, and troubleshooting.

### Project Structure

```
tab-mirror/
├── src/
│   ├── manifest.json       # Extension manifest
│   ├── background.js       # Shared state and utilities
│   ├── crypto.js           # HMAC and AES-256-GCM encryption
│   ├── pairing.js          # Device pairing protocol
│   ├── transport.js        # PeerJS WebRTC connections
│   ├── sync-engine.js      # Tab sync (atomic merge + incremental diff)
│   ├── init.js             # Message handlers and startup
│   ├── popup.html/js       # Extension popup UI
│   ├── content-test.js     # Test-mode content script
│   └── peerjs.min.js       # PeerJS library (minified)
├── tests/
│   ├── integration/        # 20 integration test suites
│   ├── helpers/            # Test utilities and Tab Mirror bridge
│   ├── run-all.js          # Full test runner
│   └── run-with-server.js  # Single-suite test runner
├── build.js                # Build system (prod + test builds)
└── test-server.js          # Local PeerJS server for testing
```

## Architecture

### Sync Algorithm

1. Both peers exchange full state on initial connect
2. Both independently compute the same deterministic merge result
3. Both apply the merge simultaneously
4. Subsequent changes sync incremental diffs, tracking `lastKnownRemoteState` per peer

### Connection Flow

1. User pairs devices (one generates pairing code, other enters it)
2. Both devices store shared HMAC key
3. Extension connects to PeerJS server for signaling
4. Lower ID initiates WebRTC connection (deterministic, no conflicts)
5. HMAC challenge/response authenticates the connection
6. AES-256-GCM encryption established for tab data
7. Initial atomic merge, then incremental diff sync

## Documentation

- [TESTING.md](TESTING.md) -- Automated and manual testing
- [SECURITY.md](SECURITY.md) -- Security and privacy
- [SERVER_SETUP.md](SERVER_SETUP.md) -- PeerJS server configuration
- [RELEASING.md](RELEASING.md) -- Release process
- [CHANGELOG.md](CHANGELOG.md) -- Version history
- [tests/README.md](tests/README.md) -- Test infrastructure and helper API

## Contributing

If you find any bugs, wish to request new features, etc. [please file them as issues.](https://github.com/MrEricSir/tab-mirror/issues)

Pull requests are welcome, but please file an associated issue and reference it for tracking purposes.

Translations are welcome! See [the English translation for an example.](https://github.com/MrEricSir/tab-mirror/blob/main/src/_locales/en/messages.json)

## License

[MIT License](LICENSE)

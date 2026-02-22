# Security & Privacy

Tab Mirror is designed with security and privacy as core requirements. This document describes the v0.1.0 security model, threat analysis, and best practices.

## Security Model

### Peer-to-Peer Architecture
- **No central server** stores your tab data
- **Direct browser-to-browser** communication via WebRTC data channels
- **PeerJS signaling server** only facilitates the initial WebRTC handshake (ICE candidates and SDP offers); it never sees tab URLs or content
- Tab data never leaves your devices except over authenticated, encrypted peer connections

### Device Identity
- Each device generates a persistent random hex ID on first run (e.g., `mirror-a1b2c3d4e5f6g7h8`), stored in `browser.storage.local`
- Test mode uses ephemeral IDs prefixed with `test-mirror-`
- Device IDs are not personally identifiable

### Pairing Protocol
Devices must be explicitly paired before they will sync. The pairing flow works as follows:

1. **Device A** starts pairing and generates a short alphanumeric code
2. **Device A** registers a temporary PeerJS peer with ID `pair-<code>`
3. **Device B** enters the code and connects to that temporary peer
4. **Device A** generates a random shared key (Base64-encoded) and sends it along with its permanent device ID to Device B
5. **Device B** stores the shared key and responds with its own device ID
6. Both devices persist the pairing (peer ID, shared key, name, timestamp) to `browser.storage.local`
7. The temporary pairing peer is destroyed

The pairing code expires after 60 seconds. The joining side times out after 30 seconds.

### Connection Authentication (HMAC Challenge/Response)
Every new connection between paired devices in production mode is authenticated:

1. The peer with the lower device ID acts as the **challenger** (deterministic role assignment)
2. Challenger generates a 16-byte random nonce and sends an `AUTH_CHALLENGE`
3. Responder computes `HMAC-SHA256(sharedKey, nonce)` and replies with `AUTH_RESPONSE`
4. Challenger verifies the HMAC; on match, the connection is accepted
5. If verification fails or times out (10 seconds), the connection is closed

In test mode, authentication is skipped unless explicitly forced via `forceAuthNextConnection`.

### End-to-End Encryption (AES-256-GCM)
All sync payloads are encrypted in production mode, on top of WebRTC's built-in DTLS:

1. The shared pairing key is used as input to **HKDF-SHA256** with a fixed salt (`tab-mirror-e2e-v1`) and info string (`aes-256-gcm-sync-encryption`) to derive a 256-bit AES-GCM key
2. Each message is encrypted with a fresh 12-byte random IV
3. The ciphertext and IV are Base64-encoded and sent as a `MIRROR_SYNC_ENCRYPTED` message
4. The receiver decrypts and parses the JSON payload; tampered or wrongly-keyed messages are silently dropped
5. Derived keys are cached per peer for the session lifetime and cleared on disconnect or unpairing

Unencrypted `MIRROR_SYNC` messages are rejected in production mode.

### WebRTC Transport Security
- **DTLS 1.2+** encryption on all WebRTC data channels (mandatory per spec)
- **ICE/STUN** for NAT traversal; no TURN relay configured by default (no third-party routing)
- The signaling server sees only connection metadata (peer IDs, ICE candidates), never application data

## Privacy Considerations

### What Is Shared Between Paired Devices
- **Tab URLs** and **titles** from the designated sync window
- **Tab group names and colors** (if tab groups are used)
- **Tab order and pinned state**

### What Is NOT Shared
- **Browsing history** -- only currently open tabs in the sync window
- **Cookies, session data, or local storage** -- not accessed
- **Form data or passwords** -- not accessed
- **Private/incognito window tabs** -- excluded entirely
- **Tabs in non-sync windows** -- only one window is synced
- **Privileged URLs** -- filtered out (see below)

### Privileged URL Filtering
These URLs are never synced:
- `about:` pages (except `about:blank`, `about:newtab`, `about:home` which are normalized)
- `chrome://` pages (browser internals)
- `moz-extension://` and `chrome-extension://` pages
- `file://` URLs (local files)
- Test bridge initialization URLs (test mode only)

### Sync Window Isolation
Only one designated browser window is synced. The sync window is selected at startup (tagged via `browser.sessions`) and persists across restarts. Other windows are completely ignored by the sync engine.

## Threat Model

### What Tab Mirror Protects Against

- **Passive network observers**: WebRTC DTLS encryption prevents eavesdropping on the transport layer; AES-256-GCM encryption protects the payload even if DTLS were somehow bypassed
- **Compromised signaling server**: The PeerJS server never receives tab data; even if compromised, an attacker cannot read sync payloads without the shared pairing key
- **Unauthorized peers**: HMAC challenge/response authentication ensures only paired devices can exchange data
- **Message tampering**: AES-GCM's authentication tag detects any modification to ciphertext
- **Private browsing leaks**: Incognito windows and tabs are explicitly excluded
- **Accidental over-sharing**: Only one window is synced; privileged URLs are filtered

### What Tab Mirror Does NOT Protect Against

- **Pairing code interception**: An attacker who observes or guesses the 8-character pairing code during the 60-second window could pair with your device and obtain the shared key. Mitigation: pair devices on a trusted network; codes expire quickly.
- **Stale paired devices**: A previously paired device retains the HMAC key indefinitely until explicitly unpaired. If that device is compromised, the attacker can authenticate and decrypt sync traffic. Mitigation: periodically review and remove unused paired devices.
- **Malicious browser extensions**: Other extensions with `tabs` permission can independently read your tab data regardless of Tab Mirror.
- **Physical device access**: Anyone with access to the device can see your tabs and read the shared keys from extension storage.
- **Screen sharing or recording**: Visible tab titles and URLs can be captured by screen recording software.

### Known Limitations

- **Public PeerJS server**: The default signaling server (`0.peerjs.com`) could theoretically log connection metadata (peer IDs, IP addresses, connection timestamps). It cannot see tab content. Mitigation: deploy your own PeerJS server.
- **No forward secrecy**: The same shared key is used for the lifetime of a pairing. Compromising the key retroactively exposes all past sync messages if they were recorded. Mitigation: unpair and re-pair periodically to rotate keys.
- **No certificate pinning**: The WebSocket connection to the PeerJS signaling server relies on standard TLS certificate validation.

## Permissions Explained

Tab Mirror requests these Firefox permissions:

### `tabs`
- **Purpose**: Read and modify tabs to capture and apply sync state
- **Scope**: All tabs across all windows (but only the sync window's tabs are actually synced)
- **Risk**: Medium -- can read all open tab URLs and titles
- **Mitigation**: Only sync window tabs are captured; privileged URLs are filtered; data is encrypted before transmission

### `storage`
- **Purpose**: Persist preferences, paired device list, device ID, and sync window tag
- **Scope**: Extension-local storage only (not browsing data)
- **Risk**: Low -- isolated to the extension

### `sessions`
- **Purpose**: Tag the sync window so it persists across browser restarts
- **Scope**: Session metadata on windows only
- **Risk**: Low -- only reads/writes a single boolean tag per window

### `idle`
- **Purpose**: Detect system idle and sleep/wake transitions for connection management
- **Scope**: System idle state only
- **Risk**: Low -- no access to user activity details

### `tabGroups`
- **Purpose**: Read and create tab groups to sync group structure between devices
- **Scope**: Tab groups in the sync window
- **Risk**: Low -- limited to group metadata (name, color, collapsed state)

### `notifications`
- **Purpose**: Show a desktop notification when a paired device connects
- **Scope**: OS-level notifications
- **Risk**: Low -- notifications contain only device name, no tab content

### `theme`
- **Purpose**: Match the popup UI styling to the current Firefox theme
- **Scope**: Read-only access to theme colors
- **Risk**: Minimal

### `https://*.peerjs.com/*`
- **Purpose**: Connect to the PeerJS signaling server for WebRTC handshake
- **Scope**: HTTPS requests to peerjs.com subdomains only
- **Risk**: Low -- only connection metadata is exchanged; tab data is never sent to this server

## Security Testing

### Automated Tests
The test suite validates security-relevant behavior:
- HMAC computation and verification (correct key, wrong nonce, wrong key)
- AES-256-GCM encryption round-trip, tamper detection, and wrong-key rejection
- Connection authentication flow (challenge/response)
- Privileged URL filtering
- Private window exclusion

Run tests:
```bash
npm test
```

### Manual Security Review Checklist
- [ ] Review `src/background.js` for sensitive data handling
- [ ] Verify privileged URL filtering in `isPrivilegedUrl()`
- [ ] Check HMAC and encryption key derivation
- [ ] Audit pairing code generation and exchange
- [ ] Verify no `eval`, `innerHTML`, or dynamic script injection
- [ ] Review PeerJS and WebRTC configuration
- [ ] Audit third-party dependencies (PeerJS is the only runtime dependency)
- [ ] Test with malformed or malicious peer messages

## Best Practices

### For Users
1. **Pair devices on a trusted network** -- the pairing code is transmitted in the clear during the exchange
2. **Remove paired devices you no longer use** -- old devices retain the shared key
3. **Keep Firefox updated** -- ensures latest WebRTC and TLS security patches
4. **Deploy your own PeerJS server** for maximum privacy over the signaling layer
5. **Close sensitive tabs** before they appear in the sync window if concerned

### For Developers
1. **Audit dependencies** regularly (`npm audit`)
2. **Keep PeerJS updated** for security patches
3. **Review permissions** before adding new ones -- request only what is necessary
4. **Follow secure coding practices** -- no eval, sanitize inputs, minimal permissions
5. **Test security scenarios** when modifying the sync or authentication code

## Compliance & Standards

### Standards Followed
- **WebRTC Security**: Follows W3C WebRTC security guidelines and RFC 8827
- **Firefox Extension Security**: Adheres to Mozilla Add-on Policies
- **Secure Coding**: No eval, proper input validation, minimal permissions

### Privacy Regulations
- **GDPR**: No personal data collected or processed by the extension; tab data is synced only between the user's own devices
- **CCPA**: No consumer data collected
- **No telemetry**: No tracking, analytics, or data collection of any kind

### Third-Party Dependencies
- **PeerJS** (^1.5.4): WebRTC wrapper library, well-maintained, community-audited
- **No other runtime dependencies**
- Development dependencies (Selenium, test bridge, etc.) are used only for testing and are not bundled in production builds

## Incident Response

### For Users
1. Disable the extension immediately in `about:addons`
2. Remove all paired devices from the extension settings
3. Check for extension updates
4. Review open tabs for sensitive information that may have been exposed

### For Developers
1. **Assess impact** -- determine what data is at risk and which versions are affected
2. **Develop and test a fix** -- verify the fix addresses the vulnerability without regressions
3. **Release a patch** immediately
4. **Notify users** via GitHub and AMO (addons.mozilla.org) if the issue is serious
5. **Update this document** with lessons learned

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** open a public GitHub issue
2. Use the GitHub Security tab to report the issue privately, or email the maintainer (see `package.json` for contact information)
3. Include: description of the vulnerability, steps to reproduce, potential impact, and suggested fix if available
4. Allow reasonable time for a fix before public disclosure

We take security seriously and aim to respond within 48 hours.

## Security Resources

- [Mozilla Extension Security Best Practices](https://extensionworkshop.com/documentation/develop/build-a-secure-extension/)
- [WebRTC Security Architecture (RFC 8827)](https://www.rfc-editor.org/rfc/rfc8827)
- [PeerJS Documentation](https://peerjs.com/docs/)

## License & Liability

Tab Mirror is provided "as is" without warranty. See the LICENSE file for details. Users are responsible for their own security practices and data protection.

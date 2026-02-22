# Releasing Tab Mirror

This document covers the steps for building, testing, and publishing a new release of Tab Mirror.

## Pre-Release Checklist

Before starting a release:

1. **All tests pass**: Run `npm test` and confirm 18/18 suites pass
2. **Manual smoke test**: Load the test build in two Firefox instances, pair them, verify tabs sync
3. **Version bumped**: Run `npm run version:bump -- <new-version>` (updates manifest, package.json, and all .md references)
4. **Changelog updated**: Add a new entry to `CHANGELOG.md`

## Build

### Production Build

```bash
npm run build:prod
```

This produces `web-ext-artifacts/production/tab_mirror-<version>.zip` with:
- `TEST_MODE = false` in `background.js`
- Production PeerJS server (`0.peerjs.com`)
- No content scripts or test infrastructure
- Production extension ID (`tab-mirror-extension@mrericsir.com`)

### Verify the Build

Before submitting, check the output:

```bash
# Inspect the zip contents
unzip -l web-ext-artifacts/production/tab_mirror-*.zip

# Run the linter (same checks AMO uses)
npm run lint
```

The zip should contain only:
- `manifest.json`
- `background.js`
- `popup.html`
- `popup.js`
- `peerjs.min.js`

It should NOT contain `content-test.js` (test-only file injected by the build system for test builds).

### Load and Test Manually

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Click "Load Temporary Add-on"
3. Select the zip from `web-ext-artifacts/production/`
4. Open the popup -- confirm it shows "Tab Mirror" with the pair/join buttons
5. Pair two instances and verify sync works

## Publishing to Mozilla Add-ons (AMO)

### First-Time Setup

1. Create a developer account at [addons.mozilla.org](https://addons.mozilla.org/developers/)
2. The extension ID in `manifest.json` (`tab-mirror-extension@mrericsir.com`) must match your AMO listing

### Submit for Review

1. Go to [AMO Developer Hub](https://addons.mozilla.org/developers/)
2. Click "Submit a New Add-on" (first time) or "Upload New Version" (updates)
3. Upload `web-ext-artifacts/production/tab_mirror-<version>.zip`
4. Fill in the listing details:
   - **Name**: Tab Mirror
   - **Summary**: Synchronize tabs across Firefox instances via peer-to-peer WebRTC
   - **Category**: Tabs
   - **License**: MIT
5. Submit for review

### Source Code Submission

AMO may request source code for review since `peerjs.min.js` is minified. If asked:

1. Provide a zip of the full repository (excluding `node_modules/`)
2. Include build instructions: `npm install && npm run build:prod`
3. Note that `peerjs.min.js` is the standard PeerJS library from npm

### Review Timeline

- **Automated review**: Usually instant (checks for obvious policy violations)
- **Manual review**: Can take days to weeks depending on AMO reviewer queue
- **Common review feedback**: Unused permissions, minified code questions, CSP concerns

## Self-Hosted Distribution

If distributing outside AMO (e.g., for testing or enterprise use):

### Signed XPI

Firefox requires extensions to be signed, even for self-hosting. Use the AMO signing API:

```bash
npx web-ext sign \
  --source-dir=build/production \
  --api-key=YOUR_JWT_ISSUER \
  --api-secret=YOUR_JWT_SECRET
```

Get API credentials from [AMO Developer Hub](https://addons.mozilla.org/developers/addon/api/key/).

### Unsigned (Development Only)

For local development without signing:
1. Go to `about:config`
2. Set `xpinstall.signatures.required` to `false` (only works in Firefox Developer Edition or Nightly)
3. Install the unsigned zip from `about:addons`

## Version Numbering

- `src/manifest.json` `"version"` is what Firefox and AMO display to users
- `package.json` `"version"` is for npm/development tooling
- Both are kept in sync automatically by `npm run version:bump -- <new-version>`

The bump script (`bump-version.js`) updates:
- `src/manifest.json` and `package.json` version fields
- Zip filename references (`tab_mirror-X.Y.Z.zip`) across all `.md` files
- Version strings (`vX.Y.Z`, `Version X.Y.Z`) across all `.md` files

## PeerJS Server

The production build defaults to `0.peerjs.com`, which has known reliability issues. For a production release, consider deploying your own PeerJS server and updating `PEER_CONFIG` in `background.js` before building. See [SERVER_SETUP.md](SERVER_SETUP.md) for deployment options.

## Post-Release

1. Tag the release in git: `git tag v<version>`
2. Push the tag: `git push origin v<version>`
3. Monitor AMO reviews and user feedback
4. Watch for connection issues if using the public PeerJS server

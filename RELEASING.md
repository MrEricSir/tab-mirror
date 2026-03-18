# Releasing Tab Mirror

This document covers the steps for building, testing, and publishing releases of Tab Mirror.

## Development Builds

Development builds are for local testing and debugging. They include test infrastructure (content scripts, test extension ID, local server config).

### Build

```bash
npm run build:test
```

This produces `web-ext-artifacts/test/tab_mirror-<version>.zip` with:
- `TEST_MODE = true` in `background.js`
- Local PeerJS server (`localhost:9000`)
- Content script (`content-test.js`) for test bridge communication
- Source map (`peerjs.min.js.map`) for debugging
- Test extension ID (`tab-mirror@test.local`)

### Load Manually

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Click "Load Temporary Add-on"
3. Select the zip from `web-ext-artifacts/test/`

### Run Tests

```bash
# Full suite (build + unit + integration)
npm test

# Unit tests only
npm run test:unit

# Single integration suite (must build first)
npm run build:test
HEADLESS=1 node tests/run-with-server.js tests/integration/basic-sync.test.js
```

## AMO Releases

Release process for https://addons.mozilla.org

### 1. Run Release Script

```bash
npm run release <version>
```

This automates the pre-upload steps:
1. Checks for clean git state (no uncommitted changes)
2. Bumps version in `manifest.json`, `package.json`, and `.md` files
3. Runs full test suite (build + unit + integration)
4. Lints with `web-ext lint`
5. Builds the production zip
6. Verifies the build (PeerJS provenance, TEST_MODE transformation, zip contents, reproducibility)
7. Creates `tab-mirror-<version>-source.tar.gz`

Script will abort on errors. Note that uncomitted changes may be present (version number, etc.)

On success, the script prints the artifact paths and remaining manual steps.

Known lint warnings (not errors):
- `innerHTML` assignments in `popup.js` - all user-controlled data is escaped via `escapeHtml()`, not raw user input
- `MISSING_DATA_COLLECTION_PERMISSIONS` notice - add `data_collection_permissions` to manifest when required

### 2. Manual Smoke Test

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Load `web-ext-artifacts/production/tab_mirror-<version>.zip` as a temporary add-on
3. Open the popup, confirm it shows "Tab Mirror" with pair/join buttons
4. Pair two instances and verify tabs sync

### 3. Submit to AMO

1. Go to the [AMO Developer Hub](https://addons.mozilla.org/developers/)
2. Click "Submit a New Add-on" (first time) or "Upload New Version" (updates)
3. Upload `web-ext-artifacts/production/tab_mirror-<version>.zip`
4. Upload `tab-mirror-<version>-source.tar.gz` as the source archive (required because `peerjs.min.js` is minified and `background.js` is transformed during build)
5. Fill in the listing details:
   - **Name**: Tab Mirror
   - **Summary**: Synchronize tabs across Firefox instances via peer-to-peer WebRTC
   - **Category**: Tabs
   - **License**: MIT
6. Paste these reviewer instructions into the AMO source code notes field:

> **Build instructions:**
> 1. `npm install`
> 2. `npm run build:prod`
> 3. Output: `web-ext-artifacts/production/tab_mirror-<version>.zip`
>
> **Automated verification:**
> Run `npm run verify` to confirm:
> - `peerjs.min.js` matches `peerjs@1.5.4` from npm
> - The only build transformation is `TEST_MODE = true` -> `false` in `background.js`
> - The build is reproducible
>
> **Build details:**
> All source files except `peerjs.min.js` are unminified, hand-written JavaScript with no bundler or transpiler. The build step (`build.js`) copies `src/` to `build/production/`, sets `const TEST_MODE = false` in `background.js`, excludes test-only files (`content-test.js`, `peerjs.min.js.map`), and packages with `web-ext build`.
>
> **Minified library:**
> `peerjs.min.js` is PeerJS v1.5.4, copied unmodified from the [peerjs npm package](https://www.npmjs.com/package/peerjs) `dist/peerjs.min.js`. To verify: `npm pack peerjs@1.5.4`, extract, and compare `dist/peerjs.min.js`.

7. Submit for review

### 4. Commit, Tag, and Push

```bash
git add -A && git commit -m "Release v<version>"
git tag v<version>
git push origin main v<version>
```

Monitor AMO reviews and user feedback after submission.

### Review Timeline

- **Automated review**: Usually instant (checks for obvious policy violations)
- **Manual review**: Can take days to weeks depending on the AMO reviewer queue
- **Common feedback**: Unused permissions, minified code questions, CSP concerns

## Version Numbering

- `src/manifest.json` `"version"` is what Firefox and AMO display to users
- `package.json` `"version"` is for npm/development tooling
- Both are kept in sync by `node bump-version.js <new-version>`

The bump script updates:
- `src/manifest.json` and `package.json` version fields
- Zip filename references (`tab_mirror-X.Y.Z.zip`) across all `.md` files
- Version strings (`vX.Y.Z`, `Version X.Y.Z`) across all `.md` files

## PeerJS Server

The production build connects to `0.peerjs.com` which may prove unreliable in the future. If so, it's possible to self-host and that can be added as an option.

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

Note: Firefox Developer Edition or Nightly can load unsigned extensions by setting `xpinstall.signatures.required` to `false` in `about:config`. Regular Firefox requires signed extensions.

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

AMO (addons.mozilla.org) releases are production builds submitted for public distribution.

### 1. Bump Version

```bash
node bump-version.js <new-version>
```

This updates `src/manifest.json`, `package.json`, and version/filename references across all `.md` files.

### 2. Run Tests

```bash
HEADLESS=1 npm test
```

Confirm all unit and integration suites pass.

### 3. Lint

```bash
npm run lint
```

AMO runs the same linter during review. Known warnings:
- `innerHTML` assignments in `popup.js` - all user-controlled data is escaped via `escapeHtml()`, not raw user input
- `MISSING_DATA_COLLECTION_PERMISSIONS` notice - add `data_collection_permissions` to manifest when required

### 4. Build Production

```bash
npm run build:prod
```

This produces `web-ext-artifacts/production/tab_mirror-<version>.zip` with:
- `TEST_MODE = false` in `background.js`
- Production PeerJS server (`0.peerjs.com`)
- No content scripts, source maps, or test infrastructure
- Production extension ID (`tab-mirror-extension@mrericsir.com`)

The production build excludes these files that are present in `src/`:
- `content-test.js` - test-only content script for log retrieval via Selenium
- `peerjs.min.js.map` - source map, unnecessary in production (~600KB)
- `.DS_Store` - macOS metadata

### 5. Verify the Build

Run the automated verification script:

```bash
npm run verify
```

This checks:
- **PeerJS provenance** - downloads `peerjs@1.5.4` from npm and confirms `peerjs.min.js` matches byte-for-byte (after Unicode normalization)
- **Build transformation** - confirms the only source change is `TEST_MODE = true` becoming `false`
- **Zip contents** - confirms test-only files are excluded and required files are present
- **Reproducibility** - builds twice and verifies identical output

You can also inspect the zip manually:

```bash
unzip -l web-ext-artifacts/production/tab_mirror-*.zip
```

Expected contents (17 files):
- `manifest.json`
- `background.js`, `bimap.js`, `crypto.js`, `init.js`, `init-helpers.js`
- `message-external.js`, `message-internal.js`
- `pairing.js`, `transport.js`, `sync-engine.js`
- `popup.html`, `popup.js`
- `peerjs.min.js`
- `icons/icon-light.svg`, `icons/icon-dark.svg`
- `_locales/en/messages.json`

### 6. Manual Smoke Test

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Load the production zip as a temporary add-on
3. Open the popup - confirm it shows "Tab Mirror" with pair/join buttons
4. Pair two instances and verify tabs sync

### 7. Submit to AMO

1. Go to the [AMO Developer Hub](https://addons.mozilla.org/developers/)
2. Click "Submit a New Add-on" (first time) or "Upload New Version" (updates)
3. Upload `web-ext-artifacts/production/tab_mirror-<version>.zip`
4. Fill in the listing details:
   - **Name**: Tab Mirror
   - **Summary**: Synchronize tabs across Firefox instances via peer-to-peer WebRTC
   - **Category**: Tabs
   - **License**: MIT
5. Submit for review

### 8. Source Code Submission

AMO requires source code when the extension contains minified or transpiled files. Since `peerjs.min.js` is minified and the build process transforms `background.js` (TEST_MODE substitution), you must upload a source archive.

Prepare the archive:

```bash
git archive --format=tar.gz --prefix=tab-mirror/ -o tab-mirror-source.tar.gz HEAD
```

Include these reviewer instructions (paste into the AMO source code notes field):

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

### 9. Post-Release

1. Tag the release: `git tag v<version>`
2. Push the tag: `git push origin v<version>`
3. Monitor AMO reviews and user feedback

### Review Timeline

- **Automated review**: Usually instant (checks for obvious policy violations)
- **Manual review**: Can take days to weeks depending on the AMO reviewer queue
- **Common feedback**: Unused permissions, minified code questions, CSP concerns

## Self-Hosted Distribution

For distributing outside AMO (e.g., beta testing or enterprise use), Firefox requires extensions to be signed. Use the AMO signing API:

```bash
npx web-ext sign \
  --source-dir=build/production \
  --api-key=YOUR_JWT_ISSUER \
  --api-secret=YOUR_JWT_SECRET
```

Get API credentials from the [AMO Developer Hub](https://addons.mozilla.org/developers/addon/api/key/).

## Version Numbering

- `src/manifest.json` `"version"` is what Firefox and AMO display to users
- `package.json` `"version"` is for npm/development tooling
- Both are kept in sync by `node bump-version.js <new-version>`

The bump script updates:
- `src/manifest.json` and `package.json` version fields
- Zip filename references (`tab_mirror-X.Y.Z.zip`) across all `.md` files
- Version strings (`vX.Y.Z`, `Version X.Y.Z`) across all `.md` files

## PeerJS Server

The production build connects to `0.peerjs.com`, which has known reliability issues. For a production release, consider deploying your own PeerJS server and updating `PEER_CONFIG` in `background.js` before building.

#!/usr/bin/env node
/**
 * Release automation for Tab Mirror.
 *
 * Runs pre-upload release steps:
 *   1. Validates version argument
 *   2. Checks clean git state
 *   3. Bumps version (manifest.json, package.json, .md files)
 *   4. Runs tests (build:test + unit + integration)
 *   5. Lints (web-ext lint)
 *   6. Builds production zip
 *   7. Verifies build
 *   8. Creates source archive
 *
 * Does NOT commit, tag, or upload. After this script completes, the user
 * is responbile for running sanity tests, uploading to AMO, and comitting
 * and tagging the release.
 *
 * Usage: node release.js <version>
 * Example: node release.js 0.2.0
 */

const { execSync } = require('child_process');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node release.js <version>');
  console.error('Example: node release.js 0.2.0');
  process.exit(1);
}

function run(label, command, opts = {}) {
  console.log(`\n=== ${label} ===\n`);
  try {
    execSync(command, {
      stdio: 'inherit',
      env: { ...process.env, ...opts.env },
    });
  } catch {
    console.error(`\nFailed at: ${label}`);
    console.error('Release aborted. Version bump changes may be uncommitted - review with `git diff`.');
    process.exit(1);
  }
}

// 1. Check clean git state
console.log('\n=== Checking git state ===\n');
const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
if (status) {
  console.error('Working directory is not clean. Commit or stash changes first.');
  console.error(status);
  process.exit(1);
}
console.log('Clean.');

// 2. Bump version
run('Bumping version', `node bump-version.js ${version}`);

// 3. Run tests (build:test + unit + integration)
run('Running tests', 'npm test', { env: { HEADLESS: '1' } });

// 4. Lint
run('Linting', 'npm run lint');

// 5. Build production
run('Building production zip', 'npm run build:prod');

// 6. Verify build
run('Verifying build', 'npm run verify');

// 7. Create source archive
const archiveFile = `tab-mirror-${version}-source.tar.gz`;
run('Creating source archive', `git archive --format=tar.gz --prefix=tab-mirror/ -o ${archiveFile} HEAD`);

// Done
console.log(`
=== Release preparation complete ===

Artifacts:
  Production zip:  web-ext-artifacts/production/tab_mirror-${version}.zip
  Source archive:  ${archiveFile}

Next steps:
  1. Smoke test: load the production zip in Firefox (about:debugging) and verify basic functionality
  2. Upload to AMO: submit the production zip and source archive at https://addons.mozilla.org/developers/
  3. Commit, tag, and push:
       git add -A && git commit -m "Release v${version}"
       git tag v${version}
       git push origin main v${version}
`);

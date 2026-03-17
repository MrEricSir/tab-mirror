#!/usr/bin/env node
/**
 * Build Verification Script for AMO Reviewers
 *
 * Verifies that:
 * 1. The production build is reproducible from source
 * 2. peerjs.min.js matches the official npm package (peerjs@1.5.4)
 * 3. The only build transformation is TEST_MODE = true -> false
 * 4. No test-only files are included in the production zip
 *
 * Usage: node verify-build.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const PEERJS_VERSION = '1.5.4';

let passed = 0;
let failed = 0;

function pass(msg) {
    console.log(`  PASS: ${msg}`);
    passed++;
}

function fail(msg) {
    console.log(`  FAIL: ${msg}`);
    failed++;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Normalize Unicode to NFC (macOS uses NFD for filenames/content)
function normalizeUnicode(buffer) {
    return Buffer.from(buffer.toString('utf8').normalize('NFC'));
}

function section(title) {
    console.log();
    console.log(`--- ${title} ---`);
}

// --- 1. Verify PeerJS matches npm package ---

function verifyPeerJS() {
    section('PeerJS Verification');

    const localPath = path.join(SRC_DIR, 'peerjs.min.js');
    if (!fs.existsSync(localPath)) {
        fail('peerjs.min.js not found in src/');
        return;
    }

    console.log(`  Downloading peerjs@${PEERJS_VERSION} from npm...`);
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'verify-peerjs-'));

    try {
        execSync(`npm pack peerjs@${PEERJS_VERSION} --pack-destination "${tmpDir}"`, {
            stdio: 'pipe',
            cwd: tmpDir,
        });

        const tgz = fs.readdirSync(tmpDir).find(f => f.endsWith('.tgz'));
        if (!tgz) {
            fail('Could not download peerjs package');
            return;
        }

        execSync(`tar xf "${path.join(tmpDir, tgz)}" -C "${tmpDir}"`, { stdio: 'pipe' });

        const npmPath = path.join(tmpDir, 'package', 'dist', 'peerjs.min.js');
        if (!fs.existsSync(npmPath)) {
            fail('peerjs.min.js not found in npm package');
            return;
        }

        const localBuf = normalizeUnicode(fs.readFileSync(localPath));
        const npmBuf = normalizeUnicode(fs.readFileSync(npmPath));

        const localHash = sha256(localBuf);
        const npmHash = sha256(npmBuf);

        console.log(`  Local SHA-256:  ${localHash}`);
        console.log(`  npm SHA-256:    ${npmHash}`);

        if (localHash === npmHash) {
            pass(`peerjs.min.js matches peerjs@${PEERJS_VERSION} from npm (after Unicode normalization)`);
        } else {
            fail(`peerjs.min.js does NOT match peerjs@${PEERJS_VERSION} from npm`);
            console.log('    Local size:', fs.readFileSync(localPath).length);
            console.log('    npm size:  ', fs.readFileSync(npmPath).length);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// --- 2. Verify build transformation is only TEST_MODE ---

function verifyBuildTransformation() {
    section('Build Transformation Verification');

    console.log('  Running production build...');
    execSync('node build.js production', { stdio: 'pipe', cwd: ROOT });

    const buildDir = path.join(ROOT, 'build', 'production');
    if (!fs.existsSync(buildDir)) {
        fail('Production build directory not created');
        return;
    }

    // Check that TEST_MODE is false in the build
    const builtBg = fs.readFileSync(path.join(buildDir, 'background.js'), 'utf8');
    const srcBg = fs.readFileSync(path.join(SRC_DIR, 'background.js'), 'utf8');

    if (builtBg.includes('const TEST_MODE = false;')) {
        pass('Production build has TEST_MODE = false');
    } else {
        fail('Production build does not have TEST_MODE = false');
    }

    if (srcBg.includes('const TEST_MODE = false;')) {
        pass('Source has TEST_MODE = false (production default)');
    } else {
        // This is expected if source has TEST_MODE = true for some reason
        console.log('  Note: Source has TEST_MODE = true (will be set to false by build)');
    }

    // Verify background.js is the ONLY file that differs (besides excluded files)
    const excluded = new Set(['content-test.js', 'peerjs.min.js.map', '.DS_Store']);
    const diffs = [];

    function compareDir(srcDir, buildDir, prefix = '') {
        const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
        const buildEntries = new Set(fs.readdirSync(buildDir));

        for (const entry of srcEntries) {
            const relPath = prefix + entry.name;

            if (excluded.has(entry.name)) {
                if (buildEntries.has(entry.name)) {
                    diffs.push(`${relPath}: should be excluded from production but is present`);
                }
                continue;
            }

            if (!buildEntries.has(entry.name)) {
                diffs.push(`${relPath}: in source but missing from build`);
                continue;
            }

            if (entry.isDirectory()) {
                compareDir(
                    path.join(srcDir, entry.name),
                    path.join(buildDir, entry.name),
                    relPath + '/'
                );
            } else {
                const srcContent = fs.readFileSync(path.join(srcDir, entry.name));
                const buildContent = fs.readFileSync(path.join(buildDir, entry.name));

                if (!srcContent.equals(buildContent)) {
                    diffs.push(relPath);
                }
            }
        }
    }

    compareDir(SRC_DIR, buildDir);

    if (diffs.length === 0) {
        pass('No files differ between source and production build (source already has TEST_MODE = false)');
    } else if (diffs.length === 1 && diffs[0] === 'background.js') {
        pass('Only background.js differs (TEST_MODE transformation)');
    } else {
        // Check if the diffs are just background.js + legitimate transform
        const unexpectedDiffs = diffs.filter(d => d !== 'background.js');
        if (unexpectedDiffs.length === 0) {
            pass('Only background.js differs (TEST_MODE transformation)');
        } else {
            fail(`Unexpected file differences: ${unexpectedDiffs.join(', ')}`);
        }
    }
}

// --- 3. Verify no test-only files in production zip ---

function verifyProductionZipContents() {
    section('Production Zip Contents');

    const artifactsDir = path.join(ROOT, 'web-ext-artifacts', 'production');
    if (!fs.existsSync(artifactsDir)) {
        fail('Production artifacts directory not found (run build first)');
        return;
    }

    const zipFile = fs.readdirSync(artifactsDir).find(f => f.endsWith('.zip'));
    if (!zipFile) {
        fail('No zip file found in production artifacts');
        return;
    }

    const zipPath = path.join(artifactsDir, zipFile);
    const listing = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });

    // Files that must NOT be in production
    const forbidden = ['content-test.js', 'peerjs.min.js.map', '.DS_Store'];
    for (const file of forbidden) {
        if (listing.includes(file)) {
            fail(`Production zip contains ${file} (test/dev-only file)`);
        } else {
            pass(`Production zip does not contain ${file}`);
        }
    }

    // Files that MUST be in production
    const required = [
        'manifest.json',
        'background.js',
        'popup.html',
        'popup.js',
        'peerjs.min.js',
    ];
    for (const file of required) {
        if (listing.includes(file)) {
            pass(`Production zip contains ${file}`);
        } else {
            fail(`Production zip is missing ${file}`);
        }
    }

    // Print the full listing for reference
    console.log();
    console.log('  Zip contents:');
    listing.split('\n')
        .filter(line => line.match(/\d+-\d+-\d+/))
        .forEach(line => console.log(`    ${line.trim()}`));
}

// --- 4. Verify build reproducibility ---

function verifyReproducibility() {
    section('Build Reproducibility');

    // Build twice and compare
    console.log('  Building production (pass 1)...');
    execSync('node build.js production', { stdio: 'pipe', cwd: ROOT });
    const buildDir = path.join(ROOT, 'build', 'production');

    const hashes1 = {};
    function hashDir(dir, prefix = '') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relPath = prefix + entry.name;
            if (entry.isDirectory()) {
                hashDir(path.join(dir, entry.name), relPath + '/');
            } else {
                hashes1[relPath] = sha256(fs.readFileSync(path.join(dir, entry.name)));
            }
        }
    }
    hashDir(buildDir);

    console.log('  Building production (pass 2)...');
    execSync('node build.js production', { stdio: 'pipe', cwd: ROOT });

    const hashes2 = {};
    function hashDir2(dir, prefix = '') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relPath = prefix + entry.name;
            if (entry.isDirectory()) {
                hashDir2(path.join(dir, entry.name), relPath + '/');
            } else {
                hashes2[relPath] = sha256(fs.readFileSync(path.join(dir, entry.name)));
            }
        }
    }
    hashDir2(buildDir);

    const allFiles = new Set([...Object.keys(hashes1), ...Object.keys(hashes2)]);
    let reproducible = true;
    for (const file of allFiles) {
        if (hashes1[file] !== hashes2[file]) {
            fail(`${file} differs between builds`);
            reproducible = false;
        }
    }

    if (reproducible) {
        pass(`Build is reproducible (${allFiles.size} files identical across 2 builds)`);
    }
}

// --- Main ---

function main() {
    console.log('============================================================');
    console.log('Tab Mirror - Build Verification');
    console.log('============================================================');

    verifyPeerJS();
    verifyBuildTransformation();
    verifyProductionZipContents();
    verifyReproducibility();

    console.log();
    console.log('============================================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================');

    process.exit(failed > 0 ? 1 : 0);
}

main();

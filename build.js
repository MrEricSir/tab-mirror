#!/usr/bin/env node
/**
 * Build script for Tab Mirror extension
 * Creates production and test builds with appropriate TEST_MODE settings
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC_DIR = path.join(__dirname, 'src');
const BUILD_DIR = path.join(__dirname, 'build');
const ARTIFACTS_DIR = path.join(__dirname, 'web-ext-artifacts');

const modes = {
    production: false,
    test: true
};

function log(message) {
    console.log(`[BUILD] ${message}`);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function setTestMode(content, testMode) {
    // Replace TEST_MODE value
    return content.replace(
        /const TEST_MODE = (true|false);/,
        `const TEST_MODE = ${testMode};`
    );
}

function copyDir(src, dest, processFile = null, processManifest = null) {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath, processFile, processManifest);
        } else {
            let content = fs.readFileSync(srcPath);

            // Process background.js if handler provided
            if (processFile && entry.name === 'background.js') {
                content = processFile(content.toString());
            }

            // Process manifest.json if handler provided
            if (processManifest && entry.name === 'manifest.json') {
                content = processManifest(content.toString());
            }

            fs.writeFileSync(destPath, content);
        }
    }
}

function buildMode(mode) {
    const testMode = modes[mode];
    const buildPath = path.join(BUILD_DIR, mode);

    log(`Building ${mode} version (TEST_MODE=${testMode})...`);

    // Manifest processor for test mode
    const manifestProcessor = testMode ? (content) => {
        const manifest = JSON.parse(content);
        // Add content script for test mode
        manifest.content_scripts = [{
            "matches": ["<all_urls>"],
            "js": ["content-test.js"],
            "run_at": "document_end"
        }];
        // Allow WS to local PeerJS server and HTTP for test pages
        manifest.content_security_policy = "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*;";
        // Add localhost permission for test HTTP server
        manifest.permissions.push("http://localhost/*");
        // Use test extension ID for test builds
        manifest.browser_specific_settings.gecko.id = "tab-mirror@test.local";
        return JSON.stringify(manifest, null, 2);
    } : null;

    // Copy source files with TEST_MODE transformation
    copyDir(SRC_DIR, buildPath, (content) => setTestMode(content, testMode), manifestProcessor);

    log(`  ✓ Copied files to build/${mode}/`);

    // Build extension
    try {
        execSync(
            `npx web-ext build --source-dir=build/${mode} --artifacts-dir=web-ext-artifacts/${mode} --overwrite-dest`,
            { stdio: 'inherit' }
        );
        log(`  ✓ Built ${mode} extension`);

        // Find the built file
        const artifactsPath = path.join(ARTIFACTS_DIR, mode);
        const files = fs.readdirSync(artifactsPath);
        const extensionFile = files.find(f => f.endsWith('.zip') || f.endsWith('.xpi'));

        if (extensionFile) {
            log(`  ✓ ${mode} extension: web-ext-artifacts/${mode}/${extensionFile}`);
        }
    } catch (error) {
        log(`  ✗ Failed to build ${mode} extension`);
        throw error;
    }
}

function clean() {
    log('Cleaning build directories...');

    if (fs.existsSync(BUILD_DIR)) {
        fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    }

    if (fs.existsSync(ARTIFACTS_DIR)) {
        fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
    }

    log('  ✓ Cleaned');
}

function main() {
    const args = process.argv.slice(2);
    const targetMode = args[0];

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           Tab Mirror Extension Builder                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    if (args.includes('--clean')) {
        clean();
        return;
    }

    // Clean before building
    clean();

    if (targetMode && modes.hasOwnProperty(targetMode)) {
        // Build specific mode
        buildMode(targetMode);
    } else {
        // Build all modes
        log('Building all versions...');
        console.log();
        for (const mode of Object.keys(modes)) {
            buildMode(mode);
            console.log('');
        }
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    BUILD COMPLETE                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    log('Available builds:');
    log('  Production: web-ext-artifacts/production/ (TEST_MODE=false)');
    log('  Test:       web-ext-artifacts/test/ (TEST_MODE=true)');
    log('');
    log('Usage:');
    log('  npm run build              - Build both versions');
    log('  npm run build:prod         - Build production only');
    log('  npm run build:test         - Build test only');
    log('  npm run build -- --clean   - Clean build directories');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error();
        console.error('Build failed:', error.message);
        process.exit(1);
    }
}

module.exports = { buildMode, clean, setTestMode };

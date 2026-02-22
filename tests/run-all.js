#!/usr/bin/env node
/**
 * Test Runner - Runs all integration tests
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_DIR = path.join(__dirname, 'integration');

let peerServerProcess;
let httpServerProcess;

// Grab all test files
function findTests() {
  if (!fs.existsSync(TEST_DIR)) {
    console.error(`Test directory not found: ${TEST_DIR}`);
    return [];
  }

  return fs.readdirSync(TEST_DIR)
    .filter(file => file.endsWith('.test.js'))
    .map(file => path.join(TEST_DIR, file));
}

// Clean up leftover Firefox profiles and processes
async function cleanupOrphans() {
  console.log();
  console.log('Cleaning up orphaned test resources...');

  const os = require('os');
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  // Clean up leftover Firefox test profiles
  try {
    const tmpDir = os.tmpdir();
    const profiles = fs.readdirSync(tmpDir).filter(name => name.startsWith('firefox-test-profile-'));

    for (const profile of profiles) {
      const profilePath = path.join(tmpDir, profile);
      try {
        fs.rmSync(profilePath, { recursive: true, force: true });
        console.log(`  Removed orphaned profile: ${profile}`);
      } catch (e) {
        // ignore
      }
    }

    if (profiles.length === 0) {
      console.log('  ✓ No orphaned profiles found');
    }
  } catch (e) {
    console.log('  Warning: Could not check for orphaned profiles:', e.message);
  }

  console.log('Cleanup complete');
  console.log();
}

// Launch a server process and wait for it to report ready.
function launchServer(label, command, args, readyPattern) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let ready = false;

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      // Log connection/disconnect events
      if (output.includes('Client connected') || output.includes('Client disconnected')) {
        console.log(`[${label}] ${output.trim()}`);
      }
      if (!ready && output.includes(readyPattern)) {
        ready = true;
        resolve(proc);
      }
    });

    proc.stderr.on('data', (data) => {
      console.error(`[${label} ERROR] ${data.toString().trim()}`);
    });

    proc.on('exit', (code) => {
      if (!ready) {
        reject(new Error(`${label} exited before ready (code ${code})`));
      } else {
        console.log(`[${label}] Process exited (code ${code})`);
      }
    });

    // Timeout
    setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error(`${label} did not become ready within 10s`));
      }
    }, 10000);
  });
}

// Start test servers
async function startServers() {
  console.log('Starting test servers...');

  peerServerProcess = await launchServer(
    'PEER', 'node', [path.join(__dirname, '..', 'test-server.js')],
    'Server running on'
  );

  httpServerProcess = await launchServer(
    'HTTP', 'node', [require.resolve('selenium-webext-bridge/lib/test-http-server')],
    'HTTP test server running'
  );

  // Track crashes so we can restart if needed
  peerServerProcess.on('exit', () => { peerServerProcess = null; });
  httpServerProcess.on('exit', () => { httpServerProcess = null; });

  console.log('Test servers ready');
  console.log();
}

// Make sure both servers are still alive, restart any that crashed.
async function ensureServersAlive() {
  if (!peerServerProcess) {
    console.log('  PeerJS server crashed, restarting...');
    peerServerProcess = await launchServer(
      'PEER', 'node', [path.join(__dirname, '..', 'test-server.js')],
      'Server running on'
    );
    peerServerProcess.on('exit', () => { peerServerProcess = null; });
  }
  if (!httpServerProcess) {
    console.log('  HTTP server crashed, restarting...');
    httpServerProcess = await launchServer(
      'HTTP', 'node', [require.resolve('selenium-webext-bridge/lib/test-http-server')],
      'HTTP test server running'
    );
    httpServerProcess.on('exit', () => { httpServerProcess = null; });
  }
}

// Clean up between test suites so stale state doesn't bleed into the next one.
// The PeerJS server piles up stale peer registrations via allow_discovery. When Firefox
// processes get force-killed they don't unregister cleanly, so listAllPeers() returns
// dead IDs that the next test's browsers try to connect to.
async function cleanupBetweenTests() {
  const { execSync } = require('child_process');
  const os = require('os');

  // 1. Wait for geckodriver to finish
  console.log('  Waiting for test processes to terminate...');
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const output = execSync('pgrep -f geckodriver 2>/dev/null | wc -l', { encoding: 'utf8' });
      const count = parseInt(output.trim());
      if (count === 0) {
        console.log('  ✓ geckodriver processes terminated');
        break;
      }
      if (i === 9 && count > 0) {
        console.log(`  Force killing ${count} geckodriver processes...`);
        try {
          execSync('pkill -9 -f geckodriver 2>/dev/null || true', { encoding: 'utf8' });
        } catch (e) {
          // ignore
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (e) {
      break; // pgrep not found or no matches
    }
  }

  // 2. Kill any leftover test Firefox processes (safe: only matches test profile paths)
  try {
    execSync('pkill -9 -f "firefox-test-profile-" 2>/dev/null || true', { encoding: 'utf8' });
  } catch (e) {
    // ignore
  }

  // 3. Clean up leftover test profiles
  try {
    const tmpDir = os.tmpdir();
    const profiles = fs.readdirSync(tmpDir).filter(name => name.startsWith('firefox-test-profile-'));
    for (const profile of profiles) {
      try {
        fs.rmSync(path.join(tmpDir, profile), { recursive: true, force: true });
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }

  // 4. Restart PeerJS server so we get a clean peer list
  console.log('  Restarting PeerJS server for clean state...');
  if (peerServerProcess) {
    peerServerProcess.kill();
    peerServerProcess = null;
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
  peerServerProcess = await launchServer(
    'PEER', 'node', [path.join(__dirname, '..', 'test-server.js')],
    'Server running on'
  );
  peerServerProcess.on('exit', () => { peerServerProcess = null; });
  console.log('  ✓ Clean PeerJS server ready');
}

// Shut down test servers
function stopServers() {
  console.log();
  console.log('Shutting down test servers...');
  if (peerServerProcess) {
    peerServerProcess.kill();
  }
  if (httpServerProcess) {
    httpServerProcess.kill();
  }
}

// Run a single test
function runTest(testPath) {
  return new Promise((resolve, reject) => {
    console.log();
    console.log('═'.repeat(60));
    console.log(`Running: ${path.basename(testPath)}`);
    console.log('═'.repeat(60));

    const child = spawn('node', [testPath], {
      stdio: 'inherit',
      env: { ...process.env }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ test: path.basename(testPath), passed: true });
      } else {
        resolve({ test: path.basename(testPath), passed: false, exitCode: code });
      }
    });

    child.on('error', (error) => {
      reject({ test: path.basename(testPath), error });
    });
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           TAB MIRROR - INTEGRATION TEST SUITE              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();

  const tests = findTests();

  if (tests.length === 0) {
    console.error('No tests found!');
    process.exit(1);
  }

  console.log(`Found ${tests.length} test suite(s):`);
  console.log();
  tests.forEach((test, i) => {
    console.log(`  ${i + 1}. ${path.basename(test)}`);
  });

  // Clean up any leftover resources from previous runs
  await cleanupOrphans();

  // Boot test servers once for all tests
  await startServers();

  console.log('Starting test execution...');
  console.log();

  const results = [];
  const startTime = Date.now();

  for (const test of tests) {
    try {
      // Make sure servers are alive before each test suite
      await ensureServersAlive();

      const result = await runTest(test);
      results.push(result);

      // Clean up processes/profiles and restart PeerJS server
      await cleanupBetweenTests();
    } catch (error) {
      results.push({ test: path.basename(test), passed: false, error: error.message });
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Show summary
  console.log();
  console.log();
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(18) + 'FINAL SUMMARY' + ' '.repeat(27) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');
  console.log();

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`Total Suites:  ${tests.length}`);
  console.log(`Passed:         ${passed}`);
  console.log(`Failed:         ${failed}`);
  console.log(`Duration:       ${duration}s`);
  console.log();

  if (failed > 0) {
    console.log('Failed suites:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ${r.test}${r.exitCode ? ` (exit code: ${r.exitCode})` : ''}`);
      if (r.error) {
        console.log(`     Error: ${r.error}`);
      }
    });
    console.log();
  }

  console.log('═'.repeat(60));
  console.log();

  // Shut down servers
  stopServers();

  process.exit(failed > 0 ? 1 : 0);
}

// Cleanup on signals
process.on('SIGINT', () => {
  console.log();
  console.log();
  console.log('Interrupted, shutting down...');
  stopServers();
  process.exit(130);
});

process.on('SIGTERM', () => {
  stopServers();
  process.exit(143);
});

// Catch unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  stopServers();
  process.exit(1);
});

main();

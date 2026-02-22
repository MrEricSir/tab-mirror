#!/usr/bin/env node
/**
 * Run tests with local servers
 *
 * This script:
 * 1. Starts the local PeerJS server (port 9000)
 * 2. Starts the local HTTP server for test pages (port 8080)
 * 3. Runs the specified test
 * 4. Shuts down servers when done
 */

const { spawn } = require('child_process');
const path = require('path');

// Grab test file from command line args
const testFile = process.argv[2] || 'tests/integration/basic-sync.test.js';
const testPath = path.resolve(__dirname, '..', testFile);

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║         TEST RUNNER WITH LOCAL SERVERS                     ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log();

let peerServerProcess;
let httpServerProcess;
let testProcess;

// Fire up PeerJS signaling server
console.log('Starting PeerJS signaling server on port 9000...');
peerServerProcess = spawn('node', ['test-server.js'], {
  stdio: ['ignore', 'pipe', 'pipe']
});

// Fire up HTTP server for test pages
console.log('Starting local HTTP server on port 8080...');
console.log();
const httpServerScript = require.resolve('selenium-webext-bridge/lib/test-http-server');
httpServerProcess = spawn('node', [httpServerScript], {
  stdio: ['ignore', 'pipe', 'pipe']
});

// Wait for both servers to come up
let peerServerReady = false;
let httpServerReady = false;

peerServerProcess.stdout.on('data', (data) => {
  const output = data.toString();
  console.log(`[PEER] ${output.trim()}`);

  if (output.includes('Server running on')) {
    peerServerReady = true;
    checkServersReady();
  }
});

peerServerProcess.stderr.on('data', (data) => {
  console.error(`[PEER ERROR] ${data.toString().trim()}`);
});

httpServerProcess.stdout.on('data', (data) => {
  const output = data.toString();
  console.log(`[HTTP] ${output.trim()}`);

  if (output.includes('HTTP test server running')) {
    httpServerReady = true;
    checkServersReady();
  }
});

httpServerProcess.stderr.on('data', (data) => {
  console.error(`[HTTP ERROR] ${data.toString().trim()}`);
});

function checkServersReady() {
  if (peerServerReady && httpServerReady) {
    runTest();
  }
}

// Run test once servers are up
function runTest() {
  console.log();
  console.log('Server ready!');
  console.log();
  console.log('Running tests...');
  console.log();
  console.log('═'.repeat(60));

  testProcess = spawn('node', [testPath], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  testProcess.on('close', (code) => {
    console.log();
    console.log('═'.repeat(60));
    console.log();
    console.log(`Test completed with exit code: ${code}`);
    console.log();

    // Shut down servers
    console.log('Shutting down servers...');
    if (peerServerProcess) {
      peerServerProcess.kill();
    }
    if (httpServerProcess) {
      httpServerProcess.kill();
    }

    process.exit(code);
  });

  testProcess.on('error', (error) => {
    console.error();
    console.error('Failed to run test:', error.message);
    if (peerServerProcess) {
      peerServerProcess.kill();
    }
    if (httpServerProcess) {
      httpServerProcess.kill();
    }
    process.exit(1);
  });
}

// Clean up on exit
process.on('SIGINT', () => {
  console.log();
  console.log();
  console.log('Interrupted, shutting down...');
  if (testProcess) {
    testProcess.kill();
  }
  if (peerServerProcess) {
    peerServerProcess.kill();
  }
  if (httpServerProcess) {
    httpServerProcess.kill();
  }
  process.exit(130);
});

process.on('SIGTERM', () => {
  if (testProcess) {
    testProcess.kill();
  }
  if (peerServerProcess) {
    peerServerProcess.kill();
  }
  if (httpServerProcess) {
    httpServerProcess.kill();
  }
  process.exit(143);
});

// Bail if servers don't start in time
setTimeout(() => {
  if (!peerServerReady || !httpServerReady) {
    console.error();
    console.error('Timeout waiting for servers to start');
    if (peerServerProcess) {
      peerServerProcess.kill();
    }
    if (httpServerProcess) {
      httpServerProcess.kill();
    }
    process.exit(1);
  }
}, 10000);

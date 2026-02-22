#!/usr/bin/env node
/**
 * PeerJS Signaling Server for Tab Mirror testing
 *
 * Provides WebRTC signaling so two browser instances can establish
 * direct P2P data channels for tab sync.
 *
 * Usage:
 *   node test-server.js         - Start on port 9000
 *   node test-server.js 9001    - Start on custom port
 */

const { PeerServer } = require('peer');

const port = parseInt(process.argv[2] || '9000', 10);

const server = PeerServer({
    port: port,
    path: '/myapp',
    allow_discovery: true
});

server.on('connection', (client) => {
    console.log(`[${new Date().toISOString()}] Client connected: ${client.getId()}`);
});

server.on('disconnect', (client) => {
    console.log(`[${new Date().toISOString()}] Client disconnected: ${client.getId()}`);
});

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║           PeerJS Signaling Test Server                     ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Server running on: http://localhost:${port}/myapp`);
console.log('');
console.log('Press Ctrl+C to stop');
console.log('────────────────────────────────────────────────────────────');

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

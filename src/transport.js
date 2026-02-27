// Transport: PeerJS WebRTC
// Manages the PeerJS peer object, discovery, dialing, and connection acceptance.
// In test mode, connects to a local signaling server. In production, uses
// 0.peerjs.com. Discovery polls listAllPeers() (test) or iterates paired
// devices (production). Lower ID peer always initiates the connection.

function setupPeerJS() {
    if (window.peer) {
        try {
            window.peer.destroy();
        } catch (e) {
            // peer might already be gone
        }
    }

    console.log(`[P2P] Connecting to signaling server:`, PEER_CONFIG);
    fileLog(`Connecting to PeerJS server`, 'P2P');

    window.peer = new Peer(myDeviceId, PEER_CONFIG);

    window.peer.on('open', (id) => {
        console.log(`[P2P] Registered: ${id}`);
        fileLog(`Registered with PeerJS server as ${id}`, 'P2P');

        discoverPeers();
        if (discoverInterval) {
            clearInterval(discoverInterval);
        }
        discoverInterval = setInterval(discoverPeers, DISCOVER_INTERVAL_MS);
    });

    window.peer.on('connection', (conn) => {
        console.log(`[P2P] Incoming connection from: ${conn.peer}`);
        fileLog(`Incoming connection from ${conn.peer}`, 'P2P');
        handleConnection(conn);
    });

    window.peer.on('error', (err) => {
        // peer-unavailable means the remote peer isn't registered yet -- not fatal
        if (err.type === 'peer-unavailable') {
            const peerId = err.message?.match(/test-mirror-[a-f0-9]+|mirror-[a-f0-9]+|pair-\d{6}/)?.[0];
            if (peerId) {
                pendingDials.delete(peerId);
                fileLog(`Peer ${peerId} not available yet`, 'P2P');
            }
            return;
        }

        console.warn(`[P2P] Error: ${err.type} - ${err.message}`);
        fileLog(`Peer error: ${err.type} - ${err.message}`, 'P2P-ERROR');
        pendingDials.clear();

        // Try to reconnect on network errors
        if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
            setTimeout(() => {
                if (window.peer && !window.peer.destroyed) {
                    window.peer.destroy();
                }
                setupPeerJS();
            }, RECONNECT_DELAY_MS);
        } else if (err.type === 'unavailable-id') {
            // ID already taken -- pick a new random ID and retry
            if (TEST_MODE) {
                const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                myDeviceId = 'test-mirror-' + hex;
                window.myDeviceId = myDeviceId;
                console.log(`[TEST MODE] ID taken, retrying as: ${myDeviceId}`);
            }
            setTimeout(() => {
                if (window.peer && !window.peer.destroyed) {
                    window.peer.destroy();
                }
                setupPeerJS();
            }, TEST_MODE ? 2000 : AUTH_TIMEOUT_MS);
        }
    });

    window.peer.on('disconnected', () => {
        console.log('[P2P] Disconnected from signaling server');
        fileLog('Disconnected from signaling server', 'P2P');
        // Try immediate reconnect
        if (window.peer && !window.peer.destroyed) {
            setTimeout(() => {
                if (window.peer && window.peer.disconnected && !window.peer.destroyed) {
                    console.log('[P2P] Attempting reconnect...');
                    window.peer.reconnect();
                }
            }, 3000);
        }
    });
}

function handleConnection(conn) {
    if (!conn) {
        return;
    }

    conn.on('open', () => {
        console.log(`[P2P] Connected to ${conn.peer}`);
        fileLog(`Connected to ${conn.peer}`, 'P2P');

        if (TEST_MODE && !forceAuthNextConnection) {
            // Test mode: trust all connections, no authentication
            acceptConnection(conn);
        } else {
            // Production (or forced auth): authenticate via HMAC challenge/response
            forceAuthNextConnection = false;
            authenticateConnection(conn);
        }
    });

    // Handle errors before open (e.g. connection refused)
    conn.on('error', (err) => {
        console.warn(`[P2P] Connection error with ${conn.peer}:`, err.type || err.message || err);
        if (connections.get(conn.peer) === conn) {
            cleanupPeerConnection(conn.peer);
        }
        const retry = connectionRetries.get(conn.peer) || { attempts: 0, lastAttempt: 0 };
        retry.attempts++;
        retry.lastAttempt = Date.now();
        connectionRetries.set(conn.peer, retry);
    });
}

function dialPeer(remoteId) {
    if (!window.peer || window.peer.disconnected || window.peer.destroyed) {
        return;
    }
    if (connections.has(remoteId) || pendingDials.has(remoteId)) {
        return;
    }

    // Exponential backoff
    const retry = connectionRetries.get(remoteId);
    if (retry) {
        const backoff = Math.min(MIN_RETRY_BACKOFF_MS * Math.pow(2, retry.attempts), MAX_RETRY_BACKOFF_MS);
        if (Date.now() - retry.lastAttempt < backoff) {
            return;
        }
    }

    console.log(`[P2P] Dialing: ${remoteId}`);
    fileLog(`Dialing ${remoteId}`, 'P2P');
    pendingDials.add(remoteId);
    // Clear pending after 10s to allow retry
    setTimeout(() => pendingDials.delete(remoteId), AUTH_TIMEOUT_MS);

    const conn = window.peer.connect(remoteId);
    handleConnection(conn);
}

async function discoverPeers() {
    if (!window.peer || window.peer.disconnected || window.peer.destroyed) {
        return;
    }

    if (TEST_MODE) {
        // Query the signaling server for all connected peers
        try {
            const allPeers = await new Promise((resolve) => {
                window.peer.listAllPeers((peers) => resolve(peers));
                setTimeout(() => resolve([]), PEER_LIST_TIMEOUT_MS);
            });
            // Lower ID dials higher to avoid duplicate connections
            for (const peerId of allPeers) {
                if (peerId === myDeviceId) {
                    continue;
                }
                if (connections.has(peerId) || pendingDials.has(peerId)) {
                    continue;
                }
                if (!peerId.startsWith('test-mirror-')) {
                    continue; // Only dial tab-mirror peers
                }
                if (myDeviceId < peerId) {
                    dialPeer(peerId);
                }
            }
        } catch (err) {
            fileLog(`listAllPeers failed: ${err.message}`, 'P2P');
        }
    } else {
        // Discover peers from paired devices list
        for (const device of pairedDevices) {
            if (device.peerId === myDeviceId) {
                continue;
            }
            if (connections.has(device.peerId) || pendingDials.has(device.peerId)) {
                continue;
            }
            if (myDeviceId < device.peerId) {
                dialPeer(device.peerId);
            }
        }
    }
}

// Setup Transport
function setupTransport() {
    setupPeerJS();
}

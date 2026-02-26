// Paired Device Storage
// Persists the paired device list to browser.storage.local.

async function loadPairedDevices() {
    try {
        const result = await browser.storage.local.get('pairedDevices');
        if (result.pairedDevices && Array.isArray(result.pairedDevices)) {
            pairedDevices = result.pairedDevices;
            console.log(`[PAIR] Loaded ${pairedDevices.length} paired devices`);
        }
    } catch (e) {
        console.warn('[PAIR] Failed to load paired devices:', e.message);
    }
}

async function savePairedDevices() {
    await browser.storage.local.set({ pairedDevices });
}

async function addPairedDevice(peerId, sharedKey, name) {
    const existing = pairedDevices.findIndex(d => d.peerId === peerId);
    const device = { peerId, sharedKey, name: name || peerId, pairedAt: Date.now() };
    if (existing >= 0) {
        pairedDevices[existing] = device;
    } else {
        pairedDevices.push(device);
    }
    await savePairedDevices();
    encryptionKeyCache.delete(peerId);
    console.log(`[PAIR] Added paired device: ${peerId}`);
}

async function removePairedDevice(peerId) {
    pairedDevices = pairedDevices.filter(d => d.peerId !== peerId);
    await savePairedDevices();
    // Close existing connection
    const conn = connections.get(peerId);
    if (conn) {
        try {
            conn.close();
        } catch (e) {
            // conn might already be closed
        }
    }
    cleanupPeerConnection(peerId);
    syncedPeers.delete(peerId);
    lastKnownRemoteState.delete(peerId);
    encryptionKeyCache.delete(peerId);
    console.log(`[PAIR] Removed paired device: ${peerId}`);
}

function getSharedKeyForPeer(peerId) {
    const device = pairedDevices.find(d => d.peerId === peerId);
    return device ? device.sharedKey : null;
}

// Pairing Protocol
// Implements a code exchange for pairing two devices. One device starts pairing
// (generates a code), the other joins with that code. Both get a shared HMAC
// key used to authenticate future connections.

async function startPairing() {
    if (pairingState) {
        cancelPairing();
    }

    const code = generatePairingCode();
    const tempPeerId = 'pair-' + code;

    pairingState = { code, tempPeer: null, status: 'waiting', error: null };

    try {
        const tempPeer = new Peer(tempPeerId, PEER_CONFIG);
        pairingState.tempPeer = tempPeer;

        tempPeer.on('open', () => {
            console.log(`[PAIR] Waiting for pairing connection on ${tempPeerId}`);
        });

        tempPeer.on('connection', async (conn) => {
            console.log(`[PAIR] Incoming pairing connection from ${conn.peer}`);
            pairingState.status = 'exchanging';

            conn.on('open', async () => {
                try {
                    const sharedKey = await generateSharedKey();
                    const deviceName = await getDeviceName();
                    conn.send({
                        type: 'PAIR_EXCHANGE',
                        peerId: myDeviceId,
                        sharedKey,
                        name: deviceName
                    });

                    // Wait for ACK
                    conn.on('data', async (data) => {
                        if (data && data.type === 'PAIR_EXCHANGE_ACK') {
                            await addPairedDevice(data.peerId, sharedKey, data.name || data.peerId);
                            // Adopt the window the user paired from as the sync window
                            if (pairingState && pairingState.requestedSyncWindowId != null) {
                                try {
                                    await adoptSyncWindow(pairingState.requestedSyncWindowId);
                                } catch (e) {
                                    console.warn('[PAIR] Failed to adopt requested sync window:', e.message);
                                }
                            }
                            pairingState.status = 'success';
                            console.log(`[PAIR] Pairing complete with ${data.peerId}`);
                            // Clean up temp peer after short delay
                            setTimeout(() => {
                                if (pairingState && pairingState.tempPeer) {
                                    try {
                                        pairingState.tempPeer.destroy();
                                    } catch (e) {
                                        // peer might already be gone
                                    }
                                }
                            }, 1000);
                            // Kick off discovery to find the new device
                            setTimeout(() => discoverPeers(), 2000);
                        }
                    });
                } catch (e) {
                    pairingState.status = 'error';
                    pairingState.error = e.message;
                }
            });
        });

        tempPeer.on('error', (err) => {
            console.warn(`[PAIR] Temp peer error: ${err.type} - ${err.message}`);
            if (pairingState) {
                pairingState.status = 'error';
                pairingState.error = err.message;
            }
        });

        // 60-second timeout
        setTimeout(() => {
            if (pairingState && pairingState.status === 'waiting') {
                pairingState.status = 'timeout';
                cancelPairing();
            }
        }, PAIRING_TIMEOUT_MS);

    } catch (e) {
        pairingState = { code: '', tempPeer: null, status: 'error', error: e.message };
    }

    return { code, status: pairingState.status };
}

async function joinPairing(code) {
    code = normalizePairingCode(code || '');
    const validChars = new RegExp(`^[${PAIRING_CHARSET}]{8}$`);
    if (!validChars.test(code)) {
        return { success: false, error: 'Invalid pairing code' };
    }

    if (!window.peer || window.peer.disconnected || window.peer.destroyed) {
        return { success: false, error: 'Not connected to signaling server' };
    }

    const tempPeerId = 'pair-' + code;
    pairingState = { code, tempPeer: null, status: 'connecting', error: null };

    try {
        const conn = window.peer.connect(tempPeerId);

        conn.on('open', () => {
            pairingState.status = 'exchanging';
            console.log(`[PAIR] Connected to pairing peer ${tempPeerId}`);
        });

        conn.on('data', async (data) => {
            if (data && data.type === 'PAIR_EXCHANGE') {
                const deviceName = await getDeviceName();
                await addPairedDevice(data.peerId, data.sharedKey, data.name || data.peerId);
                // Adopt the window the user paired from as the sync window
                if (pairingState && pairingState.requestedSyncWindowId != null) {
                    try {
                        await adoptSyncWindow(pairingState.requestedSyncWindowId);
                    } catch (e) {
                        console.warn('[PAIR] Failed to adopt requested sync window:', e.message);
                    }
                }
                conn.send({
                    type: 'PAIR_EXCHANGE_ACK',
                    peerId: myDeviceId,
                    name: deviceName
                });
                pairingState.status = 'success';
                console.log(`[PAIR] Pairing complete with ${data.peerId}`);
                // Close pairing connection after ACK sent
                setTimeout(() => {
                    try {
                        conn.close();
                    } catch (e) {
                        // conn might already be closed
                    }
                }, 1000);
                // Kick off discovery to find the new device
                setTimeout(() => discoverPeers(), 2000);
            }
        });

        conn.on('error', (err) => {
            console.warn(`[PAIR] Join error: ${err.type || err.message}`);
            if (pairingState) {
                pairingState.status = 'error';
                pairingState.error = err.message || 'Connection failed';
            }
        });

        // 30-second timeout
        setTimeout(() => {
            if (pairingState && (pairingState.status === 'connecting' || pairingState.status === 'exchanging')) {
                pairingState.status = 'timeout';
                pairingState.error = 'Pairing timed out';
            }
        }, PAIRING_JOIN_TIMEOUT_MS);

        return { success: true };
    } catch (e) {
        pairingState = { code: '', tempPeer: null, status: 'error', error: e.message };
        return { success: false, error: e.message };
    }
}

function cancelPairing() {
    if (pairingState && pairingState.tempPeer) {
        try {
            pairingState.tempPeer.destroy();
        } catch (e) {
            // peer might already be gone
        }
    }
    pairingState = null;
}

// Authentication
// Validates new connections via HMAC challenge/response before accepting them.
// Lower ID peer sends a nonce challenge, higher ID peer responds with an HMAC.
// Skipped in test mode unless forceAuthNextConnection is set.

function showPeerConnectedNotification(peerId) {
    if (notifiedPeers.has(peerId)) {
        return;
    }
    const device = pairedDevices.find(d => d.peerId === peerId);
    if (!device) {
        return;
    }
    notifiedPeers.add(peerId);
    const message = `Connected to ${device.name || peerId}`;
    notificationLog.push({ time: Date.now(), peerId, message });
    if (notificationLog.length > MAX_NOTIFICATION_LOG) {
        notificationLog.shift();
    }
    browser.notifications.create(`peer-connected-${peerId}`, {
        type: 'basic',
        title: 'Tab Mirror',
        message
    });
}

function showPeerDisconnectedNotification(peerId) {
    const device = pairedDevices.find(d => d.peerId === peerId);
    if (!device) {
        return;
    }
    const message = `Disconnected from ${device.name || peerId}`;
    notificationLog.push({ time: Date.now(), peerId, message });
    if (notificationLog.length > MAX_NOTIFICATION_LOG) {
        notificationLog.shift();
    }
    // Remove from notifiedPeers so reconnection triggers new connect notification
    notifiedPeers.delete(peerId);
    browser.notifications.create(`peer-disconnected-${peerId}`, {
        type: 'basic',
        title: 'Tab Mirror',
        message
    });
}

function scheduleDisconnectNotification(peerId) {
    cancelDisconnectNotification(peerId);
    const timerId = setTimeout(() => {
        pendingDisconnectTimers.delete(peerId);
        showPeerDisconnectedNotification(peerId);
    }, disconnectNotifyDelayMs);
    pendingDisconnectTimers.set(peerId, timerId);
}

function cancelDisconnectNotification(peerId) {
    const timerId = pendingDisconnectTimers.get(peerId);
    if (timerId != null) {
        clearTimeout(timerId);
        pendingDisconnectTimers.delete(peerId);
    }
}

function acceptConnection(conn) {
    console.log(`[P2P] Accepted connection: ${conn.peer}`);
    fileLog(`Accepted connection: ${conn.peer}`, 'P2P');
    connections.set(conn.peer, conn);
    pendingDials.delete(conn.peer);
    connectionRetries.delete(conn.peer);
    knownPeers = Array.from(connections.keys());
    authenticatedPeers.add(conn.peer);
    lastMessageTime.set(conn.peer, Date.now());

    conn.on('data', async (data) => {
        lastMessageTime.set(conn.peer, Date.now());
        if (data && data.type === 'MIRROR_SYNC_ENCRYPTED') {
            const encKey = await getOrDeriveEncryptionKey(conn.peer);
            if (!encKey) {
                console.warn(`[CRYPTO] No decryption key for ${conn.peer}, dropping encrypted message`);
                fileLog(`No decryption key for ${conn.peer}`, 'SECURITY');
                return;
            }
            const decrypted = await decryptState(encKey, data);
            if (decrypted && decrypted.type === 'MIRROR_SYNC') {
                handleSync(decrypted);
            }
        } else if (data && data.type === 'MIRROR_SYNC') {
            if (TEST_MODE) {
                handleSync(data);
            } else {
                console.warn(`[SECURITY] Rejected unencrypted MIRROR_SYNC from ${conn.peer}`);
                fileLog(`Rejected unencrypted sync from ${conn.peer}`, 'SECURITY');
            }
        } else if (data && data.type === 'MIRROR_PING') {
            if (!outgoingMuted) {
                try {
                    conn.send({ type: 'MIRROR_PONG' });
                } catch (e) {
                    // conn might be closed
                }
            }
        }
        // MIRROR_PONG: no-op (timestamp already updated above)
    });

    conn.on('close', () => {
        if (connections.get(conn.peer) !== conn) {
            console.log(`[P2P] Stale connection closed (replaced): ${conn.peer}`);
            return;
        }
        console.log(`[P2P] Connection closed: ${conn.peer}`);
        fileLog(`Connection closed: ${conn.peer}`, 'P2P');
        cleanupPeerConnection(conn.peer);
        scheduleDisconnectNotification(conn.peer);
    });

    conn.on('error', (err) => {
        if (connections.get(conn.peer) !== conn) {
            return; // Stale connection error, ignore
        }
        console.warn(`[P2P] Connection error with ${conn.peer}:`, err.type || err.message || err);
        cleanupPeerConnection(conn.peer);
        const retry = connectionRetries.get(conn.peer) || { attempts: 0, lastAttempt: 0 };
        retry.attempts++;
        retry.lastAttempt = Date.now();
        connectionRetries.set(conn.peer, retry);
    });

    cancelDisconnectNotification(conn.peer);
    showPeerConnectedNotification(conn.peer);

    // Send current state to new peer after short delay
    trigger(BROADCAST_AFTER_SYNC_MS);
}

function authenticateConnection(conn) {
    const sharedKey = getSharedKeyForPeer(conn.peer);
    if (!sharedKey) {
        console.log(`[AUTH] Rejecting unpaired peer: ${conn.peer}`);
        fileLog(`Rejected unpaired peer: ${conn.peer}`, 'AUTH');
        try {
            conn.close();
        } catch (e) {
            // conn might already be closed
        }
        return;
    }

    // Lower ID is the challenger (keeps roles deterministic)
    const iAmChallenger = myDeviceId < conn.peer;

    if (iAmChallenger) {
        // Send challenge
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');

        conn.send({ type: 'AUTH_CHALLENGE', nonce });
        fileLog(`Sent AUTH_CHALLENGE to ${conn.peer}`, 'AUTH');

        const authTimeout = setTimeout(() => {
            console.log(`[AUTH] Auth timeout for ${conn.peer}`);
            try {
                conn.close();
            } catch (e) {
                // conn might already be closed
            }
        }, AUTH_TIMEOUT_MS);

        conn.on('data', async function authHandler(data) {
            if (data && data.type === 'AUTH_RESPONSE') {
                clearTimeout(authTimeout);
                conn.off('data', authHandler);
                const valid = await verifyHMAC(sharedKey, nonce, data.hmac);
                if (valid) {
                    console.log(`[AUTH] Peer ${conn.peer} authenticated`);
                    fileLog(`Peer ${conn.peer} authenticated`, 'AUTH');
                    acceptConnection(conn);
                } else {
                    console.log(`[AUTH] Invalid HMAC from ${conn.peer}`);
                    fileLog(`Invalid HMAC from ${conn.peer}`, 'AUTH');
                    try {
                        conn.close();
                    } catch (e) {
                        // conn might already be closed
                    }
                }
            }
        });
    } else {
        // Wait for challenge
        const authTimeout = setTimeout(() => {
            console.log(`[AUTH] Auth timeout waiting for challenge from ${conn.peer}`);
            try {
                conn.close();
            } catch (e) {
                // conn might already be closed
            }
        }, AUTH_TIMEOUT_MS);

        conn.on('data', async function authHandler(data) {
            if (data && data.type === 'AUTH_CHALLENGE') {
                clearTimeout(authTimeout);
                conn.off('data', authHandler);
                const hmac = await computeHMAC(sharedKey, data.nonce);
                conn.send({ type: 'AUTH_RESPONSE', hmac });
                fileLog(`Sent AUTH_RESPONSE to ${conn.peer}`, 'AUTH');
                // Responder considers itself authenticated after sending the response
                acceptConnection(conn);
            }
        });
    }
}

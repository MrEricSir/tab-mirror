// Message Handlers (Test Bridge + Popup)
// Handles runtime.onMessageExternal (test bridge API and inter-extension
// messages) and runtime.onMessage (popup status queries, log retrieval).

// External messages from Test Bridge extension
browser.runtime.onMessageExternal.addListener(async (message, sender) => {
    try {
        switch (message.action) {
            case 'getState':
                return {
                    success: true,
                    data: {
                        myDeviceId,
                        syncWindowId,
                        connections: knownPeers,
                        syncedPeers: Array.from(syncedPeers),
                        syncCounter,
                        isProcessingRemote,
                        pendingSyncQueueLength: pendingSyncQueue.length,
                        lastRemoteSyncTime,
                        tabMappings: {
                            tabIdToSyncId: Array.from(TAB_ID_TO_SYNC_ID),
                            syncIdToTabId: Array.from(SYNC_ID_TO_TAB_ID),
                            groupIdToSyncId: Array.from(GROUP_ID_TO_SYNC_ID),
                            syncIdToGroupId: Array.from(SYNC_ID_TO_GROUP_ID)
                        }
                    }
                };

            case 'getLogs':
                // Return structured log objects for test compatibility
                const structuredLogs = logBuffer.slice(-100).map(entry => {
                    const match = entry.match(/\[([^\]]+)\]\s\[([^\]]+)\]\s\[([^\]]+)\]\s(.*)/);
                    if (match) {
                        return { timestamp: match[1], level: match[3], message: match[4] };
                    }
                    return { timestamp: '', level: 'INFO', message: entry };
                });
                return { success: true, data: structuredLogs };

            case 'triggerSync':
                await broadcastState();
                return { success: true, data: 'Sync triggered' };

            case 'getBroadcastStats':
                return { success: true, data: { ...broadcastStats } };

            case 'resetBroadcastStats':
                broadcastStats = { attempted: 0, completed: 0, deferred: 0 };
                return { success: true, data: 'Stats reset' };

            case 'createStaleMapping': {
                // Test-only: creates a sync ID mapping to a non-existent tab ID
                // so tests can verify error logging when the tab is gone.
                const { syncId, tabId } = message;
                TAB_ID_TO_SYNC_ID.set(tabId, syncId);
                SYNC_ID_TO_TAB_ID.set(syncId, tabId);
                return { success: true, data: 'Stale mapping created' };
            }

            case 'createPrivateWindow': {
                // Test-only: creates a private (incognito) window and a tab in it.
                const privWin = await browser.windows.create({
                    incognito: true,
                    url: message.url || 'about:blank'
                });
                return { success: true, data: { windowId: privWin.id } };
            }

            case 'forceReplaceLocalState': {
                // Test-only: captures current state and re-applies it via
                // replaceLocalState to test that group handling is idempotent.
                // Returns group counts before and after for assertions.
                const allTabsBefore = await browser.tabs.query({ windowId: syncWindowId });
                const groupsBefore = browser.tabGroups
                    ? (await browser.tabGroups.query({ windowId: syncWindowId })).length
                    : 0;

                const currentState = await captureLocalState();
                isProcessingRemote = true;
                try {
                    await replaceLocalState(currentState.tabs, currentState.groups || {});
                } finally {
                    isProcessingRemote = false;
                }

                const allTabsAfter = await browser.tabs.query({ windowId: syncWindowId });
                const groupsAfter = browser.tabGroups
                    ? (await browser.tabGroups.query({ windowId: syncWindowId })).length
                    : 0;

                return {
                    success: true,
                    data: {
                        tabsBefore: allTabsBefore.filter(t => !isPrivilegedUrl(t.url)).length,
                        tabsAfter: allTabsAfter.filter(t => !isPrivilegedUrl(t.url)).length,
                        groupsBefore,
                        groupsAfter
                    }
                };
            }

            case 'getGroupCount': {
                // Test-only: returns the number of tab groups in the sync window.
                if (!browser.tabGroups) {
                    return { success: true, data: { groups: 0, groupedTabs: 0 } };
                }
                const groups = await browser.tabGroups.query({ windowId: syncWindowId });
                const tabs = await browser.tabs.query({ windowId: syncWindowId });
                const groupedTabs = tabs.filter(t => t.groupId !== undefined && t.groupId !== -1);
                return {
                    success: true,
                    data: {
                        groups: groups.length,
                        groupedTabs: groupedTabs.length,
                        groupDetails: groups.map(g => ({
                            id: g.id,
                            title: g.title,
                            color: g.color,
                            tabCount: tabs.filter(t => t.groupId === g.id).length
                        }))
                    }
                };
            }

            case 'addPairedDevice': {
                // Test-only: add a device to the paired devices list
                await addPairedDevice(message.peerId, message.sharedKey || 'test-key', message.name || message.peerId);
                return { success: true, data: { count: pairedDevices.length } };
            }

            case 'getPairedDevices': {
                // Test-only: get paired devices with connection status
                return {
                    success: true,
                    data: pairedDevices.map(d => ({
                        peerId: d.peerId,
                        name: d.name,
                        pairedAt: d.pairedAt,
                        connected: connections.has(d.peerId)
                    }))
                };
            }

            case 'getNotificationLog': {
                return {
                    success: true,
                    data: { log: notificationLog, notifiedPeers: Array.from(notifiedPeers) }
                };
            }

            case 'unpairDevice': {
                // Test-only: remove a device from the paired devices list
                await removePairedDevice(message.peerId);
                return { success: true, data: { count: pairedDevices.length } };
            }

            case 'startPairing': {
                const result = await startPairing();
                return { success: true, data: { code: formatPairingCode(result.code), status: result.status } };
            }

            case 'joinPairing': {
                const result = await joinPairing(message.code);
                return { success: true, data: result };
            }

            case 'getPairingStatus': {
                if (!pairingState) {
                    return { success: true, data: { status: 'none' } };
                }
                return { success: true, data: { status: pairingState.status, code: pairingState.code, error: pairingState.error } };
            }

            case 'cancelPairing': {
                cancelPairing();
                return { success: true };
            }

            case 'forceAuthNextConnection': {
                forceAuthNextConnection = true;
                return { success: true };
            }

            case 'testHMAC': {
                const key = await generateSharedKey();
                const nonce = message.nonce || 'test-nonce-' + Date.now();
                const hmac = await computeHMAC(key, nonce);
                const valid = await verifyHMAC(key, nonce, hmac);
                const invalidMsg = await verifyHMAC(key, 'wrong-nonce', hmac);
                const invalidKey = await verifyHMAC(await generateSharedKey(), nonce, hmac);
                return { success: true, data: { hmac, valid, invalidMsg, invalidKey } };
            }

            case 'testEncryption': {
                const tKey = await generateSharedKey();
                const tCryptoKey = await deriveEncryptionKey(tKey);
                const testPayload = {
                    type: 'MIRROR_SYNC', peerId: 'test-peer', timestamp: Date.now(),
                    tabs: [{ sId: 'sid_test', url: 'https://example.com', index: 0, pinned: false, muted: false }],
                    groups: {}
                };
                const encrypted = await encryptState(tCryptoKey, testPayload);
                const decrypted = await decryptState(tCryptoKey, encrypted);
                // Tamper test: flip a byte in ciphertext
                const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -2) + 'AA' };
                const shouldBeNull = await decryptState(tCryptoKey, tampered);
                // Wrong key test
                const wrongCryptoKey = await deriveEncryptionKey(await generateSharedKey());
                const wrongKeyResult = await decryptState(wrongCryptoKey, encrypted);
                return { success: true, data: {
                    encrypted: !!encrypted.ciphertext,
                    decrypted: decrypted !== null && decrypted.type === 'MIRROR_SYNC',
                    tabsMatch: decrypted && decrypted.tabs.length === 1 && decrypted.tabs[0].url === 'https://example.com',
                    tamperDetected: shouldBeNull === null,
                    wrongKeyDetected: wrongKeyResult === null
                }};
            }

            case 'injectRemoteState': {
                // Test-only: inject arbitrary remote state to test validation
                // Set a fresh timestamp so the timestamp guard doesn't block it
                const injected = { ...message.remoteState, timestamp: Date.now() + 1000 };
                await handleSync(injected);
                return { success: true, data: 'injected' };
            }

            case 'setStalePeerTimeout': {
                stalePeerTimeout = message.timeout;
                return { success: true, data: `Stale peer timeout set to ${message.timeout}ms` };
            }

            case 'muteOutgoing': {
                outgoingMuted = message.muted;
                return { success: true, data: `Outgoing muted: ${outgoingMuted}` };
            }

            case 'runHealthCheck': {
                runHealthCheck();
                return { success: true, data: 'Health check executed' };
            }

            case 'getLastMessageTimes': {
                const entries = {};
                for (const [peerId, time] of lastMessageTime) {
                    entries[peerId] = time;
                }
                return { success: true, data: entries };
            }

            case 'disconnectPeer': {
                const dc = connections.get(message.peerId);
                if (dc) {
                    dc.close();
                    connections.delete(message.peerId);
                    authenticatedPeers.delete(message.peerId);
                    lastMessageTime.delete(message.peerId);
                    knownPeers = Array.from(connections.keys());
                }
                return { success: true, data: { disconnected: !!dc } };
            }

            case 'testSyncQueue': {
                // Deterministic test: verify sync queue mechanics
                const results = {};

                // 1. Set processing flag to simulate busy state
                isProcessingRemote = true;
                pendingSyncQueue = [];

                // 2. Queue two syncs from different peers
                const fakeState1 = {
                    type: 'MIRROR_SYNC', peerId: 'test-peer-1',
                    tabs: [{ url: 'https://peer1.example.com', sId: 'sq1' }],
                    groups: {}, timestamp: Date.now() + 1000
                };
                const fakeState2 = {
                    type: 'MIRROR_SYNC', peerId: 'test-peer-2',
                    tabs: [{ url: 'https://peer2.example.com', sId: 'sq2' }],
                    groups: {}, timestamp: Date.now() + 1001
                };
                await handleSync(fakeState1);
                await handleSync(fakeState2);
                results.queuedTwo = pendingSyncQueue.length === 2;

                // 3. Queue a newer state from peer 1: Should replace the first
                const fakeState1b = {
                    type: 'MIRROR_SYNC', peerId: 'test-peer-1',
                    tabs: [{ url: 'https://peer1-updated.example.com', sId: 'sq1b' }],
                    groups: {}, timestamp: Date.now() + 1002
                };
                await handleSync(fakeState1b);
                results.replacedOlder = pendingSyncQueue.length === 2;
                results.newestKept = pendingSyncQueue.find(s => s.peerId === 'test-peer-1')
                    ?.tabs[0]?.url === 'https://peer1-updated.example.com';

                // 4. Clean up: Release lock without processing queue
                pendingSyncQueue = [];
                isProcessingRemote = false;

                return { success: true, data: results };
            }

            case 'simulateRestart':
                // Test-only: simulates a restart by clearing in-memory state
                // but keeping syncedPeers (persisted via storage.local).
                // Reproduces the "Sync Now loses groups" scenario.
                lastKnownRemoteState.clear();
                connectionRetries.clear();
                lastMessageTime.clear();
                lastRemoteSyncTime = 0;
                TAB_ID_TO_SYNC_ID.clear();
                SYNC_ID_TO_TAB_ID.clear();
                GROUP_ID_TO_SYNC_ID.clear();
                SYNC_ID_TO_GROUP_ID.clear();
                localGroupChanges.clear();
                pendingSyncQueue = [];
                syncHistory = [];
                notifiedPeers.clear();
                notificationLog = [];
                connections.forEach(conn => {
                    try {
                        conn.close();
                    } catch (e) {
                        // conn might already be closed
                    }
                });
                connections.clear();
                pendingDials.clear();
                knownPeers = [];
                if (discoverInterval) {
                    clearInterval(discoverInterval);
                }
                if (window.peer && !window.peer.destroyed) {
                    try {
                        window.peer.destroy();
                    } catch (e) {
                        // peer might already be gone
                    }
                }
                // Re-assign sync IDs to existing tabs and reconnect
                await captureLocalState();
                setupPeerJS();
                return { success: true, data: 'Restart simulated' };

            default:
                return { success: false, error: `Unknown action: ${message.action}` };
        }
    } catch (error) {
        console.error('[MSG] Error handling external message:', error);
        return { success: false, error: error.message };
    }
});

// Internal messages from popup and content scripts
browser.runtime.onMessage.addListener((message, sender) => {
    // Log retrieval for test mode
    if (message.type === 'GET_TEST_LOGS') {
        return Promise.resolve({ logs: logBuffer.join('\n') });
    }

    if (message.action === 'getStatus') {
        return Promise.resolve({
            id: myDeviceId,
            peers: knownPeers.length,
            pairedCount: pairedDevices.length,
            online: !!(window.peer && !window.peer.disconnected),
            lastSyncTime: lastRemoteSyncTime,
            syncPaused
        });
    }

    if (message.action === 'getDebugInfo') {
        return Promise.resolve({
            id: myDeviceId,
            syncWindowId,
            online: !!(window.peer && !window.peer.disconnected),
            peers: knownPeers.length,
            connectedPeers: knownPeers,
            pendingDials: pendingDials.size,
            tabMappings: TAB_ID_TO_SYNC_ID.size,
            groupMappings: GROUP_ID_TO_SYNC_ID.size,
            isProcessingRemote,
            lastSyncTime: lastRemoteSyncTime > 0 ? new Date(lastRemoteSyncTime).toISOString() : 'never',
            syncCounter,
            syncedPeers: Array.from(syncedPeers),
            pairedDevices: pairedDevices.map(d => ({ peerId: d.peerId, name: d.name, pairedAt: d.pairedAt })),
            authenticatedPeers: Array.from(authenticatedPeers),
            version: 'peerjs-v3',
            uptime: Math.round((Date.now() - startTime) / 1000) + 's',
            transport: TEST_MODE ? 'PeerJS (local)' : 'PeerJS (0.peerjs.com)',
            syncHistory
        });
    }

    if (message.action === 'fullSystemRefresh') {
        syncedPeers.clear();
        knownPeers = [];
        lastRemoteSyncTime = 0;
        syncCounter = 0;
        lastKnownRemoteState.clear();
        connectionRetries.clear();
        authenticatedPeers.clear();
        encryptionKeyCache.clear();
        pendingSyncQueue = [];
        syncHistory = [];
        notifiedPeers.clear();
        notificationLog = [];
        cancelPairing();
        TAB_ID_TO_SYNC_ID.clear();
        SYNC_ID_TO_TAB_ID.clear();
        // Tear down PeerJS
        connections.forEach((conn) => {
            try {
                conn.close();
            } catch (e) {
                // conn might already be closed
            }
        });
        connections.clear();
        pendingDials.clear();
        if (discoverInterval) {
            clearInterval(discoverInterval);
        }
        if (window.peer) {
            try {
                window.peer.destroy();
            } catch (e) {
                // peer might already be gone
            }
            window.peer = null;
        }
        // Re-setup
        setupTransport();
        return Promise.resolve({ success: true });
    }

    if (message.action === 'manualConnect') {
        const peerId = message.peerId;
        if (peerId) {
            dialPeer(peerId);
        }
        return Promise.resolve({ success: true });
    }

    if (message.action === 'triggerSync') {
        return (async () => {
            await broadcastState();
            return { success: true };
        })();
    }

    if (message.action === 'setSyncPaused') {
        syncPaused = !!message.paused;
        browser.storage.local.set({ syncPaused });
        return Promise.resolve({ success: true, paused: syncPaused });
    }

    if (message.action === 'getSyncPaused') {
        return Promise.resolve({ paused: syncPaused });
    }

    if (message.action === 'startPairing') {
        return (async () => {
            const result = await startPairing();
            return { success: true, code: formatPairingCode(result.code), status: result.status };
        })();
    }

    if (message.action === 'joinPairing') {
        return (async () => {
            const result = await joinPairing(message.code);
            return result;
        })();
    }

    if (message.action === 'getPairingStatus') {
        if (!pairingState) {
            return Promise.resolve({ status: 'none' });
        }
        return Promise.resolve({
            status: pairingState.status,
            code: pairingState.code,
            error: pairingState.error
        });
    }

    if (message.action === 'cancelPairing') {
        cancelPairing();
        return Promise.resolve({ success: true });
    }

    if (message.action === 'getPairedDevices') {
        return Promise.resolve({
            devices: pairedDevices.map(d => ({
                peerId: d.peerId,
                name: d.name,
                pairedAt: d.pairedAt,
                connected: connections.has(d.peerId)
            }))
        });
    }

    if (message.action === 'unpairDevice') {
        return (async () => {
            await removePairedDevice(message.peerId);
            return { success: true };
        })();
    }

    return false;
});

// Tab Event Listeners
// Watches for tab create, remove, update, move, and attach events in the sync
// window. Each fires a debounced broadcast. All listeners bail out early when
// isProcessingRemote is true to avoid echo loops during incoming sync.
browser.tabs.onCreated.addListener((tab) => {
    if (isProcessingRemote) {
        return;
    }
    if (tab.windowId !== syncWindowId) {
        return;
    }
    console.log(`[TAB] Created: ${tab.id}`);
    trigger(BROADCAST_DEBOUNCE_FAST_MS);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (isProcessingRemote) {
        return;
    }
    if (removeInfo.windowId !== syncWindowId) {
        return;
    }
    console.log(`[TAB] Removed: ${tabId}`);
    // Clean up mappings
    const syncId = TAB_ID_TO_SYNC_ID.get(tabId);
    if (syncId) {
        TAB_ID_TO_SYNC_ID.delete(tabId);
        SYNC_ID_TO_TAB_ID.delete(syncId);
    }
    trigger(BROADCAST_DEBOUNCE_FAST_MS);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (isProcessingRemote) {
        return;
    }
    if (tab.windowId !== syncWindowId) {
        return;
    }
    if (changeInfo.url || changeInfo.pinned !== undefined || changeInfo.mutedInfo || changeInfo.groupId !== undefined) {
        console.log(`[TAB] Updated: ${tabId} ${changeInfo.url ? 'url=' + changeInfo.url : ''}`);
        trigger(BROADCAST_DEBOUNCE_MS);
    }
});

browser.tabs.onMoved.addListener((tabId, moveInfo) => {
    if (isProcessingRemote) {
        return;
    }
    if (moveInfo.windowId !== syncWindowId) {
        return;
    }
    console.log(`[TAB] Moved: ${tabId} ${moveInfo.fromIndex} -> ${moveInfo.toIndex}`);
    trigger(BROADCAST_DEBOUNCE_MS);
});

browser.tabs.onAttached.addListener((tabId, attachInfo) => {
    if (isProcessingRemote) {
        return;
    }
    if (attachInfo.newWindowId !== syncWindowId) {
        return;
    }
    trigger(BROADCAST_DEBOUNCE_MS);
});

browser.tabs.onDetached.addListener((tabId, detachInfo) => {
    if (isProcessingRemote) {
        return;
    }
    if (detachInfo.oldWindowId !== syncWindowId) {
        return;
    }
    // Tab was dragged out of the sync window, clean up its mappings
    const syncId = TAB_ID_TO_SYNC_ID.get(tabId);
    if (syncId) {
        TAB_ID_TO_SYNC_ID.delete(tabId);
        SYNC_ID_TO_TAB_ID.delete(syncId);
    }
    trigger(BROADCAST_DEBOUNCE_FAST_MS);
});

// Tab Group Event Listeners
// Watches for group create, update, and remove events to trigger broadcasts.
// Records local group modification timestamps for conflict resolution.
if (browser.tabGroups) {
    browser.tabGroups.onCreated.addListener((group) => {
        if (isProcessingRemote) {
            return;
        }
        if (group.windowId !== syncWindowId) {
            return;
        }
        let gSyncId = GROUP_ID_TO_SYNC_ID.get(group.id);
        if (!gSyncId) {
            gSyncId = generateSyncId('gsid_');
            GROUP_ID_TO_SYNC_ID.set(group.id, gSyncId);
            SYNC_ID_TO_GROUP_ID.set(gSyncId, group.id);
        }
        localGroupChanges.set(gSyncId, Date.now());
        trigger(BROADCAST_DEBOUNCE_MS);
    });

    browser.tabGroups.onUpdated.addListener((group) => {
        if (isProcessingRemote) {
            return;
        }
        if (group.windowId !== syncWindowId) {
            return;
        }
        const gSyncId = GROUP_ID_TO_SYNC_ID.get(group.id);
        if (gSyncId) {
            localGroupChanges.set(gSyncId, Date.now());
        }
        trigger(BROADCAST_DEBOUNCE_MS);
    });

    browser.tabGroups.onRemoved.addListener((group) => {
        if (isProcessingRemote) {
            return;
        }
        if (group.windowId !== syncWindowId) {
            return;
        }
        const gSyncId = GROUP_ID_TO_SYNC_ID.get(group.id);
        if (gSyncId) {
            GROUP_ID_TO_SYNC_ID.delete(group.id);
            SYNC_ID_TO_GROUP_ID.delete(gSyncId);
            localGroupChanges.delete(gSyncId);
        }
        trigger(BROADCAST_DEBOUNCE_MS);
    });
}

// Sync Window Management
// One window is the "sync window" and only its tabs are synced. On boot, an
// existing window tagged via browser.sessions is reused; otherwise a new one
// is created. If the sync window gets closed, the next available window is
// adopted as a fallback.

async function adoptSyncWindow(winId) {
    syncWindowId = winId;
    await browser.sessions.setWindowValue(winId, 'tabMirrorSyncWindow', true);
    console.log(`[WINDOW] Adopted sync window: ${winId}`);
    fileLog(`Adopted sync window: ${winId}`, 'WINDOW');
    // Re-map tabs in the new window
    TAB_ID_TO_SYNC_ID.clear();
    SYNC_ID_TO_TAB_ID.clear();
    GROUP_ID_TO_SYNC_ID.clear();
    SYNC_ID_TO_GROUP_ID.clear();
    await captureLocalState();
    trigger(BROADCAST_DEBOUNCE_FAST_MS);
}

browser.windows.onRemoved.addListener(async (windowId) => {
    if (windowId === syncWindowId) {
        console.log(`[WINDOW] Sync window ${windowId} closed`);
        fileLog(`Sync window ${windowId} closed`, 'WINDOW');
        syncWindowId = null;

        // Try to adopt another existing normal window
        try {
            const allWindows = await browser.windows.getAll({ windowTypes: ['normal'] });
            const candidates = allWindows.filter(w => !w.incognito && w.id !== windowId);
            if (candidates.length > 0) {
                await adoptSyncWindow(candidates[0].id);
            } else {
                console.log('[WINDOW] No other windows: Syncing disabled until a new window opens');
            }
        } catch (e) {
            console.warn('[WINDOW] Failed to find replacement window:', e.message);
        }
    }
});

browser.windows.onCreated.addListener(async (win) => {
    if (syncWindowId !== null) {
        return;
    }
    if (win.incognito) {
        return;
    }
    if (win.type !== 'normal') {
        return;
    }

    console.log(`[WINDOW] New window ${win.id} opened while sync disabled`);
    await adoptSyncWindow(win.id);
});

// Wake From Sleep Detection
// Detects sleep/wake by checking for large gaps between setInterval ticks.
// On wake, tears down and rebuilds the PeerJS connection since WebRTC data
// channels don't survive a network interruption.
let wasIdle = false;
let lastTickTime = Date.now();

function handleWake() {
    console.log('[WAKE] Detected wake from sleep - reconnecting');
    fileLog('Wake from sleep detected', 'WAKE');

    // Close all connections and destroy peer
    connections.forEach((conn) => {
        try {
            conn.close();
        } catch (e) {
            // conn might already be closed
        }
    });
    connections.clear();
    pendingDials.clear();
    connectionRetries.clear();
    knownPeers = [];
    if (discoverInterval) {
        clearInterval(discoverInterval);
    }

    // Recreate peer after delay
    setTimeout(() => {
        if (window.peer && !window.peer.destroyed) {
            try {
                window.peer.destroy();
            } catch (e) {
                // peer might already be gone
            }
        }
        setupPeerJS();
    }, 2000);
}

// Idle API detection
try {
    browser.idle.setDetectionInterval(60);
    browser.idle.onStateChanged.addListener((newState) => {
        if (newState === 'active' && wasIdle) {
            handleWake();
        }
        wasIdle = (newState === 'idle' || newState === 'locked');
    });
} catch (e) {
    // idle API might not be available
}

// Fallback: detect time jumps > 2 minutes (covers cases idle API misses)
setInterval(() => {
    const now = Date.now();
    if (now - lastTickTime > SLEEP_DETECTION_THRESHOLD_MS) {
        handleWake();
    }
    lastTickTime = now;
}, SLEEP_DETECTION_INTERVAL_MS);

// Connection Health Check
// Runs periodically to find dead or stale connections. Dead connections
// (conn.open === false) get cleaned up right away. Live connections that
// haven't received any data within stalePeerTimeout are considered stale
// and closed. Everything else gets a MIRROR_PING liveness probe.
function runHealthCheck() {
    if (connections.size === 0) {
        return;
    }

    const now = Date.now();
    for (const [peerId, conn] of connections) {
        if (!conn.open) {
            console.log(`[HEALTH] Dead connection: ${peerId}`);
            fileLog(`Dead connection detected: ${peerId}`, 'HEALTH');
            connections.delete(peerId);
            lastMessageTime.delete(peerId);
            knownPeers = Array.from(connections.keys());
            // Try reconnecting
            setTimeout(() => {
                if (myDeviceId < peerId) {
                    dialPeer(peerId);
                }
            }, RECONNECT_DELAY_MS);
        } else {
            const lastTime = lastMessageTime.get(peerId) || 0;
            if (lastTime > 0 && (now - lastTime) > stalePeerTimeout) {
                console.log(`[HEALTH] Stale peer detected: ${peerId} (${Math.round((now - lastTime) / 1000)}s since last message)`);
                fileLog(`Stale peer detected: ${peerId} (${Math.round((now - lastTime) / 1000)}s silent)`, 'HEALTH');
                try {
                    conn.close();
                } catch (e) {
                    // conn might already be closed
                }
                connections.delete(peerId);
                lastMessageTime.delete(peerId);
                authenticatedPeers.delete(peerId);
                knownPeers = Array.from(connections.keys());
                // Try reconnecting
                setTimeout(() => {
                    if (myDeviceId < peerId) {
                        dialPeer(peerId);
                    }
                }, RECONNECT_DELAY_MS);
            } else if (!outgoingMuted) {
                try {
                    conn.send({ type: 'MIRROR_PING' });
                } catch (e) {
                    // conn might be closed
                }
            }
        }
    }
}
setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL_MS);

// Cleanup on Unload/Suspend
browser.runtime.onSuspend.addListener(() => {
    if (window.peer) {
        try {
            window.peer.destroy();
        } catch (e) {
            // peer might already be gone
        }
    }
});

window.addEventListener('unload', () => {
    if (window.peer) {
        try {
            window.peer.destroy();
        } catch (e) {
            // peer might already be gone
        }
    }
});

// Init
// Loads device ID and synced peer set from storage, finds or creates the sync
// window, captures the initial tab state, and starts the PeerJS transport.
(async () => {
    // Load or generate persistent device ID (production only)
    if (!TEST_MODE) {
        try {
            const stored = await browser.storage.local.get('deviceId');
            if (stored.deviceId) {
                myDeviceId = stored.deviceId;
            } else {
                const bytes = crypto.getRandomValues(new Uint8Array(8));
                myDeviceId = 'mirror-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
                await browser.storage.local.set({ deviceId: myDeviceId });
            }
            window.myDeviceId = myDeviceId;
            console.log(`[BOOT] Device ID: ${myDeviceId}`);
        } catch (e) {
            // Fallback if storage fails
            const bytes = crypto.getRandomValues(new Uint8Array(8));
            myDeviceId = 'mirror-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
            window.myDeviceId = myDeviceId;
        }
    }

    // Load previously synced peers
    try {
        const result = await browser.storage.local.get('syncedPeers');
        if (result.syncedPeers && Array.isArray(result.syncedPeers)) {
            result.syncedPeers.forEach(id => syncedPeers.add(id));
            console.log(`[BOOT] Loaded ${syncedPeers.size} synced peers from storage`);
        }
    } catch (e) {
        console.warn('[BOOT] Failed to load synced peers:', e.message);
    }

    // Load paired devices (production only)
    if (!TEST_MODE) {
        await loadPairedDevices();
    }

    // Load sync paused state
    try {
        const result = await browser.storage.local.get('syncPaused');
        if (result.syncPaused) {
            syncPaused = true;
        }
    } catch (e) {
        // storage might not be available
    }

    // Select the sync window (single non-private window for all sync operations)
    try {
        const allWindows = await browser.windows.getAll({ windowTypes: ['normal'] });
        const normalWindows = allWindows.filter(w => !w.incognito);

        // First: look for a previously tagged window
        for (const win of normalWindows) {
            try {
                const tag = await browser.sessions.getWindowValue(win.id, 'tabMirrorSyncWindow');
                if (tag) {
                    syncWindowId = win.id;
                    console.log(`[BOOT] Found tagged sync window: ${syncWindowId}`);
                    break;
                }
            } catch (e) {
                // sessions API might fail for some windows
            }
        }

        // Second: if no tagged window, pick the first non-incognito window and tag it
        if (syncWindowId === null && normalWindows.length > 0) {
            syncWindowId = normalWindows[0].id;
            await browser.sessions.setWindowValue(syncWindowId, 'tabMirrorSyncWindow', true);
            console.log(`[BOOT] Tagged new sync window: ${syncWindowId}`);
        }

        if (syncWindowId === null) {
            console.log('[BOOT] No non-private window found: Syncing disabled');
        }
    } catch (e) {
        console.warn('[BOOT] Failed to select sync window:', e.message);
    }

    // Assign sync IDs to pre-existing tabs
    await captureLocalState();

    // Start transport
    setupTransport();

    // Aggressive initial discovery: try every 3s for the first 2 minutes
    let initialDiscoveryAttempts = 0;
    const initialDiscovery = setInterval(() => {
        initialDiscoveryAttempts++;
        if (initialDiscoveryAttempts >= MAX_INITIAL_DISCOVERY_ATTEMPTS || connections.size > 0) {
            clearInterval(initialDiscovery);
            return;
        }
        discoverPeers();
    }, INITIAL_DISCOVERY_INTERVAL_MS);

    // Normal discovery every 20s (runs continuously as a fallback)
    setInterval(discoverPeers, DISCOVER_INTERVAL_MS);

    console.log(`[BOOT] Ready. Transport: ${TEST_MODE ? 'PeerJS (local)' : 'PeerJS (0.peerjs.com)'}`);
    fileLog('Extension ready', 'BOOT');
})();

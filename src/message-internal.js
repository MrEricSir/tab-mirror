// Internal Message Handler (Popup & Content Scripts)
// Handles runtime.onMessage for popup status queries, sync control,
// pairing commands, and log retrieval.

browser.runtime.onMessage.addListener((message, sender) => {
    // Log retrieval for test mode
    if (message.type === 'GET_TEST_LOGS') {
        return Promise.resolve({ logs: logBuffer.join('\n') });
    }

    if (message.action === 'getStatus') {
        return Promise.resolve({
            id: myDeviceId,
            peers: connectionState.knownPeers.length,
            pairedCount: pairedDevices.length,
            online: !!(window.peer && !window.peer.disconnected),
            lastSyncTime: Math.max(0, ...lastRemoteSyncTime.values()),
            syncPaused,
            syncContainerTabs,
            syncWindowId,
            tabCount: tabSyncIds.size,
            isProcessingRemote
        });
    }

    if (message.action === 'getDebugInfo') {
        return Promise.resolve({
            id: myDeviceId,
            syncWindowId,
            online: !!(window.peer && !window.peer.disconnected),
            peers: connectionState.knownPeers.length,
            connectedPeers: connectionState.knownPeers,
            pendingDials: connectionState.pendingDials.size,
            tabMappings: tabSyncIds.size,
            groupMappings: groupSyncIds.size,
            isProcessingRemote,
            lastSyncTime: lastRemoteSyncTime.size > 0 ? new Date(Math.max(...lastRemoteSyncTime.values())).toISOString() : 'never',
            syncCounter,
            syncedPeers: Array.from(syncedPeers),
            pairedDevices: pairedDevices.map(d => ({ peerId: d.peerId, name: d.name, pairedAt: d.pairedAt, keyGeneration: d.keyGeneration || 1 })),
            authenticatedPeers: Array.from(authenticatedPeers),
            version: 'peerjs-v3',
            uptime: Math.round((Date.now() - startTime) / 1000) + 's',
            transport: TEST_MODE ? 'PeerJS (local)' : 'PeerJS (0.peerjs.com)',
            syncHistory
        });
    }

    if (message.action === 'fullSystemRefresh') {
        resetAllState({ includeAuth: true });
        cancelPairing();
        browser.storage.local.remove([
            'syncIdMappings', 'groupSyncIdMappings', 'lastBroadcastTabs', 'peerRemoteStates'
        ]).catch(() => {});
        if (window.peer) {
            try {
                window.peer.destroy();
            } catch (e) {
                // peer might already be gone
            }
            window.peer = null;
        }
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
        const wasPaused = syncPaused;
        syncPaused = !!message.paused;
        browser.storage.local.set({ syncPaused });
        if (wasPaused && !syncPaused) {
            broadcastState();
        }
        return Promise.resolve({ success: true, paused: syncPaused });
    }

    if (message.action === 'getSyncPaused') {
        return Promise.resolve({ paused: syncPaused });
    }

    if (message.action === 'setSyncContainerTabs') {
        syncContainerTabs = !!message.enabled;
        browser.storage.local.set({ syncContainerTabs });
        broadcastState();
        return Promise.resolve({ success: true, syncContainerTabs });
    }

    if (message.action === 'adoptSyncWindowFromPopup') {
        return (async () => {
            const winId = message.windowId;
            if (winId == null) {
                return { success: false, error: 'No windowId provided' };
            }
            try {
                await adoptSyncWindow(winId);
                return { success: true };
            } catch (e) {
                syncWindowId = null;
                return { success: false, error: e.message };
            }
        })();
    }

    if (message.action === 'startPairing') {
        return (async () => {
            if (message.windowId != null) {
                pairingState = pairingState || {};
                pairingState.requestedSyncWindowId = message.windowId;
            }
            const result = await startPairing();
            return {
                success: true,
                code: formatPairingCode(result.code),
                status: result.status
            };
        })();
    }

    if (message.action === 'joinPairing') {
        return (async () => {
            if (message.windowId != null) {
                pairingState = pairingState || {};
                pairingState.requestedSyncWindowId = message.windowId;
            }
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
                connected: connectionState.connections.has(d.peerId)
            }))
        });
    }

    if (message.action === 'unpairDevice') {
        return (async () => {
            await removePairedDevice(message.peerId);
            return { success: true };
        })();
    }

    if (message.action === 'rotateKey') {
        return (async () => {
            const result = await rotateKeyForPeer(message.peerId);
            return result;
        })();
    }

    return false;
});

// External Message Handler (Test Bridge API)
// Handles runtime.onMessageExternal for test bridge commands and
// inter-extension communication.

browser.runtime.onMessageExternal.addListener(async (message, sender) => {
    try {
        switch (message.action) {
            case 'getState':
                return {
                    success: true,
                    data: {
                        myDeviceId,
                        syncWindowId,
                        connections: connectionState.knownPeers,
                        syncedPeers: Array.from(syncedPeers),
                        syncCounter,
                        isProcessingRemote,
                        pendingSyncQueueLength: pendingSyncQueue.length,
                        lastRemoteSyncTime: Object.fromEntries(lastRemoteSyncTime),
                        tabMappings: {
                            tabIdToSyncId: tabSyncIds.toJSON(),
                            syncIdToTabId: tabSyncIds.toJSON().map(([a, b]) => [b, a]),
                            groupIdToSyncId: groupSyncIds.toJSON(),
                            syncIdToGroupId: groupSyncIds.toJSON().map(([a, b]) => [b, a])
                        }
                    }
                };

            case 'getLogs':
                // Return structured log objects for test compatibility
                const structuredLogs = logBuffer.slice(-100).map(entry => {
                    const match = entry.match(/\[([^\]]+)\]\s\[([^\]]+)\]\s\[([^\]]+)\]\s(.*)/);
                    if (match) {
                        return {
                            timestamp: match[1],
                            level: match[3],
                            message: match[4]
                        };
                    }
                    return {
                        timestamp: '',
                        level: 'INFO',
                        message: entry
                    };
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
                tabSyncIds.set(tabId, syncId);
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
                    return {
                        success: true,
                        data: { groups: 0, groupedTabs: 0 }
                    };
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
                            collapsed: g.collapsed,
                            tabCount: tabs.filter(t => t.groupId === g.id).length
                        }))
                    }
                };
            }

            case 'collapseGroup': {
                // Test-only: set collapsed state on a tab group
                if (!browser.tabGroups) {
                    return { success: false, error: 'Tab Groups API not available' };
                }
                await browser.tabGroups.update(message.groupId, { collapsed: !!message.collapsed });
                return { success: true, data: 'Group collapsed state updated' };
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
                        connected: connectionState.connections.has(d.peerId)
                    }))
                };
            }

            case 'getNotificationLog': {
                return {
                    success: true,
                    data: {
                        log: notificationState.getLog(),
                        notifiedPeers: notificationState.getNotifiedPeers()
                    }
                };
            }

            case 'unpairDevice': {
                // Test-only: remove a device from the paired devices list
                await removePairedDevice(message.peerId);
                return { success: true, data: { count: pairedDevices.length } };
            }

            case 'adoptSyncWindow': {
                // Test-only: switch the sync window to a different window ID
                await adoptSyncWindow(message.windowId);
                return { success: true, data: { syncWindowId } };
            }

            case 'startPairing': {
                const result = await startPairing();
                return {
                    success: true,
                    data: {
                        code: formatPairingCode(result.code),
                        status: result.status
                    }
                };
            }

            case 'joinPairing': {
                const result = await joinPairing(message.code);
                return { success: true, data: result };
            }

            case 'getPairingStatus': {
                if (!pairingState) {
                    return { success: true, data: { status: 'none' } };
                }
                return {
                    success: true,
                    data: {
                        status: pairingState.status,
                        code: pairingState.code,
                        error: pairingState.error
                    }
                };
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
                return {
                    success: true,
                    data: { hmac, valid, invalidMsg, invalidKey }
                };
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
                return {
                    success: true,
                    data: {
                        encrypted: !!encrypted.ciphertext,
                        decrypted: decrypted !== null && decrypted.type === 'MIRROR_SYNC',
                        tabsMatch: decrypted && decrypted.tabs.length === 1 && decrypted.tabs[0].url === 'https://example.com',
                        tamperDetected: shouldBeNull === null,
                        wrongKeyDetected: wrongKeyResult === null
                    }
                };
            }

            case 'getCapturedState': {
                // Test-only: returns the result of captureLocalState() so tests
                // can inspect what URLs the extension would broadcast to peers.
                const captured = await captureLocalState();
                return { success: true, data: captured };
            }

            case 'testNormalizeUrl': {
                // Test-only: runs normalizeUrl() and returns the result so tests
                // can verify URL normalization logic in the extension runtime.
                return { success: true, data: normalizeUrl(message.url) };
            }

            case 'injectRemoteState': {
                // Test-only: inject arbitrary remote state to test validation
                // Set a fresh timestamp so the timestamp guard doesn't block it
                const injected = { ...message.remoteState, timestamp: Date.now() + 1000 };
                await handleSync(injected);
                return { success: true, data: 'injected' };
            }

            case 'setStalePeerTimeout': {
                connectionState.stalePeerTimeout = message.timeout;
                return { success: true, data: `Stale peer timeout set to ${message.timeout}ms` };
            }

            case 'setDisconnectNotifyDelay': {
                notificationState.setDisconnectDelay(message.delay);
                return { success: true, data: `Disconnect notify delay set to ${message.delay}ms` };
            }

            case 'pauseDiscovery': {
                connectionState.stopDiscovery();
                return { success: true, data: 'Discovery paused' };
            }

            case 'resumeDiscovery': {
                if (!connectionState._discoverInterval) {
                    discoverPeers();
                    connectionState._discoverInterval = setInterval(discoverPeers, DISCOVER_INTERVAL_MS);
                }
                return { success: true, data: 'Discovery resumed' };
            }

            case 'setRedirectSuppressionWindow': {
                urlSuppression.setSuppressionWindow(message.ms);
                return { success: true, data: `Redirect suppression window set to ${message.ms}ms` };
            }

            case 'setSyncPaused': {
                const wasPaused = syncPaused;
                syncPaused = !!message.paused;
                browser.storage.local.set({ syncPaused });
                if (wasPaused && !syncPaused) {
                    broadcastState();
                }
                return { success: true, data: { paused: syncPaused } };
            }

            case 'getSyncPaused': {
                return { success: true, data: { paused: syncPaused } };
            }

            case 'setSyncContainerTabs': {
                syncContainerTabs = !!message.enabled;
                browser.storage.local.set({ syncContainerTabs });
                broadcastState();
                return { success: true, data: { syncContainerTabs } };
            }

            case 'getSyncContainerTabs': {
                return { success: true, data: { syncContainerTabs } };
            }

            case 'createContainerTab': {
                // Test-only: creates a tab in a named container
                const containerMap = await getContainerMap();
                const storeId = containerMap.byName.get(message.containerName);
                const createOpts = {
                    url: message.url || 'about:blank',
                    windowId: syncWindowId,
                    active: false
                };
                if (storeId) {
                    createOpts.cookieStoreId = storeId;
                }
                const newTab = await browser.tabs.create(createOpts);
                return {
                    success: true,
                    data: {
                        tabId: newTab.id,
                        containerName: storeId ? message.containerName : null,
                        cookieStoreId: newTab.cookieStoreId
                    }
                };
            }

            case 'getContainers': {
                // Test-only: returns all container identities
                if (!browser.contextualIdentities) {
                    return { success: true, data: [] };
                }
                const identities = await browser.contextualIdentities.query({});
                return {
                    success: true,
                    data: identities.map(ci => ({
                        name: ci.name,
                        cookieStoreId: ci.cookieStoreId,
                        color: ci.color,
                        icon: ci.icon
                    }))
                };
            }

            case 'getTabContainerInfo': {
                // Test-only: returns a tab's container info
                const tab = await browser.tabs.get(message.tabId);
                const containerMap = await getContainerMap();
                const containerName = containerMap.byId.get(tab.cookieStoreId) || null;
                return {
                    success: true,
                    data: {
                        cookieStoreId: tab.cookieStoreId,
                        containerName,
                        isDefault: !tab.cookieStoreId || tab.cookieStoreId === 'firefox-default'
                    }
                };
            }

            case 'createContainer': {
                // Test-only: creates a new container identity
                if (!browser.contextualIdentities) {
                    return { success: false, error: 'contextualIdentities API not available' };
                }
                const identity = await browser.contextualIdentities.create({
                    name: message.name,
                    color: message.color || 'blue',
                    icon: message.icon || 'circle'
                });
                return {
                    success: true,
                    data: {
                        name: identity.name,
                        cookieStoreId: identity.cookieStoreId,
                        color: identity.color
                    }
                };
            }

            case 'rotateKey': {
                const result = await rotateKeyForPeer(message.peerId);
                return { success: true, data: result };
            }

            case 'getKeyGeneration': {
                const device = pairedDevices.find(d => d.peerId === message.peerId);
                if (!device) {
                    return { success: true, data: { keyGeneration: null } };
                }
                return { success: true, data: { keyGeneration: device.keyGeneration || 1 } };
            }

            case 'muteOutgoing': {
                connectionState.outgoingMuted = message.muted;
                return { success: true, data: `Outgoing muted: ${connectionState.outgoingMuted}` };
            }

            case 'runHealthCheck': {
                runHealthCheck();
                return { success: true, data: 'Health check executed' };
            }

            case 'getLastMessageTimes': {
                const entries = {};
                for (const [peerId, time] of connectionState.lastMessageTime) {
                    entries[peerId] = time;
                }
                return { success: true, data: entries };
            }

            case 'disconnectPeer': {
                const dc = connectionState.connections.get(message.peerId);
                if (dc) {
                    dc.close();
                    connectionState.cleanup(message.peerId);
                    scheduleDisconnectNotification(message.peerId);
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
                resetAllState();
                if (window.peer && !window.peer.destroyed) {
                    try {
                        window.peer.destroy();
                    } catch (e) {
                        // peer might already be gone
                    }
                }
                // Restore persisted state and re-assign sync IDs (matches real boot)
                await restoreSyncMappings();
                await restoreRemoteStates();
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

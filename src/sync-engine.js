// Tracks the last-seen title+color per group sync ID so captureLocalState() can
// detect changes even when tabGroups.onUpdated doesn't fire (cross-extension
// issue on Linux headless Firefox).
const lastSeenGroupProps = new Map(); // gSyncId -> { title, color }

// Capture Local State
// Grabs all syncable tabs and groups from the sync window. Each tab and group
// gets a stable sync ID if it doesn't have one yet. The result is the payload
// we send to peers via broadcastState().
async function captureLocalState() {
    const tabs = await browser.tabs.query({ windowId: syncWindowId });

    const syncableTabs = tabs
        .map(t => ({ ...t, url: normalizeUrl(t.url) }))
        .filter(t => isSyncableUrl(t.url));

    // Grab group data if the API is available
    let groupData = {};
    if (browser.tabGroups) {
        try {
            const groups = await browser.tabGroups.query({ windowId: syncWindowId });
            for (const group of groups) {
                let gSyncId = GROUP_ID_TO_SYNC_ID.get(group.id);
                if (!gSyncId) {
                    gSyncId = generateSyncId('gsid_');
                    GROUP_ID_TO_SYNC_ID.set(group.id, gSyncId);
                    SYNC_ID_TO_GROUP_ID.set(gSyncId, group.id);
                }
                // Only keep groups that actually have tabs
                const groupTabs = syncableTabs.filter(t => t.groupId === group.id);
                if (groupTabs.length > 0) {
                    const title = group.title || '';
                    const color = group.color || 'grey';
                    // Detect changes missed by tabGroups.onUpdated
                    const prev = lastSeenGroupProps.get(gSyncId);
                    if (prev && (prev.title !== title || prev.color !== color)) {
                        localGroupChanges.set(gSyncId, Date.now());
                    }
                    lastSeenGroupProps.set(gSyncId, { title, color });
                    groupData[gSyncId] = {
                        title,
                        color,
                        lastModified: localGroupChanges.get(gSyncId) || Date.now()
                    };
                }
            }
        } catch (e) {
            // tabGroups API might not work
        }
    }

    const tabData = syncableTabs.map(t => {
        let sId = TAB_ID_TO_SYNC_ID.get(t.id);
        if (!sId) {
            sId = generateSyncId('sid_');
            TAB_ID_TO_SYNC_ID.set(t.id, sId);
            SYNC_ID_TO_TAB_ID.set(sId, t.id);
        }
        const tabInfo = {
            sId,
            url: t.url,
            index: t.index,
            pinned: t.pinned,
            muted: t.mutedInfo ? t.mutedInfo.muted : false
        };
        // Add group sync ID if tab is in a group
        if (browser.tabGroups && t.groupId !== undefined && t.groupId !== -1) {
            const gSyncId = GROUP_ID_TO_SYNC_ID.get(t.groupId);
            if (gSyncId) {
                tabInfo.groupSyncId = gSyncId;
            }
        }
        return tabInfo;
    });

    return {
        type: 'MIRROR_SYNC',
        peerId: myDeviceId,
        timestamp: Date.now(),
        tabs: tabData,
        groups: groupData
    };
}

// Broadcast
// Captures local state and sends it to all connected peers. Only one broadcast
// runs at a time (serialized via broadcastInFlight); overlapping calls get
// deferred and re-triggered once the current one finishes.
async function broadcastState() {
    if (syncWindowId === null) {
        return;
    }
    if (outgoingMuted || syncPaused) {
        return;
    }
    broadcastStats.attempted++;
    if (isProcessingRemote) {
        broadcastStats.deferred++;
        broadcastPending = true;
        fileLog('Deferring broadcast - processing remote update', 'BROADCAST');
        return;
    }
    if (broadcastInFlight) {
        broadcastStats.deferred++;
        broadcastPending = true;
        fileLog('Deferring broadcast - already in flight', 'BROADCAST');
        return;
    }

    broadcastInFlight = true;
    try {
        const state = await captureLocalState();
        console.log(`[BROADCAST] ${state.tabs.length} tabs to ${connections.size} peer(s)`);
        fileLog(`Broadcasting ${state.tabs.length} tabs`, 'BROADCAST');

        for (const [peerId, conn] of connections) {
            if (conn.open) {
                try {
                    let payload = state;
                    if (!TEST_MODE) {
                        const encKey = await getOrDeriveEncryptionKey(peerId);
                        if (encKey) {
                            payload = await encryptState(encKey, state);
                        } else {
                            console.warn(`[BROADCAST] No encryption key for ${peerId}, skipping`);
                            fileLog(`No encryption key for ${peerId}, skipping send`, 'SECURITY');
                            continue;
                        }
                    }
                    conn.send(payload);
                } catch (e) {
                    console.warn(`[BROADCAST] Failed to send to ${peerId}, closing dead connection:`, e.message);
                    conn.close();
                    connections.delete(peerId);
                    authenticatedPeers.delete(peerId);
                    lastMessageTime.delete(peerId);
                    knownPeers = Array.from(connections.keys());
                }
            }
        }
        broadcastStats.completed++;
    } catch (error) {
        console.error('[BROADCAST] Error:', error);
    } finally {
        broadcastInFlight = false;
        if (broadcastPending) {
            broadcastPending = false;
            trigger(BROADCAST_DEBOUNCE_MS);
        }
    }
}

function trigger(debounceMs = BROADCAST_DEBOUNCE_MS) {
    clearTimeout(broadcastDebounce);
    broadcastDebounce = setTimeout(() => broadcastState(), debounceMs);
}

// Atomic Merge
// Runs on first contact with a peer. Both tab sets get combined into one list:
// higher peer ID's tabs go first, then the lower's. Duplicates are removed by
// sync ID and by URL+pinned. Groups are unioned. The merged result gets applied
// via replaceLocalState().
async function performAtomicMerge(myState, remoteState) {
    console.log(`[MERGE] Atomic merge with ${remoteState.peerId}`);
    fileLog(`=== ATOMIC MERGE with ${remoteState.peerId} ===`, 'MERGE');

    // Higher peer ID goes first (keeps merge order stable)
    const iAmFirst = myDeviceId > remoteState.peerId;
    const firstState = iAmFirst ? myState : remoteState;
    const secondState = iAmFirst ? remoteState : myState;

    // Dedup by sync ID first, then by URL+pinned to handle restarts
    // where sync IDs get regenerated for the same tabs.
    const seenSyncIds = new Set();
    const mergedTabs = [];

    // Count URL occurrences in firstState for URL-based dedup
    const firstUrlCounts = new Map();
    for (const tab of firstState.tabs) {
        if (tab.url) {
            const key = `${tab.url}|${tab.pinned || false}`;
            firstUrlCounts.set(key, (firstUrlCounts.get(key) || 0) + 1);
        }
    }

    // Add all firstState tabs
    for (const tab of firstState.tabs) {
        seenSyncIds.add(tab.sId);
        mergedTabs.push(tab);
    }

    // Add secondState tabs, dedup by sync ID and by URL
    for (const tab of secondState.tabs) {
        if (seenSyncIds.has(tab.sId)) {
            continue;
        }
        seenSyncIds.add(tab.sId);

        // URL dedup: skip if firstState already has this URL+pinned combo
        if (tab.url) {
            const key = `${tab.url}|${tab.pinned || false}`;
            const remaining = firstUrlCounts.get(key) || 0;
            if (remaining > 0) {
                firstUrlCounts.set(key, remaining - 1);
                fileLog(`Dedup by URL: ${tab.url} (already in first state)`, 'MERGE');
                continue;
            }
        }

        mergedTabs.push(tab);
    }

    // Merge groups (union of both group sets)
    const mergedGroups = { ...(firstState.groups || {}), ...(secondState.groups || {}) };

    console.log(`[MERGE] Result: ${mergedTabs.length} tabs (${firstState.tabs.length} + ${secondState.tabs.length}, ${mergedTabs.length} unique)`);
    fileLog(`Merged: ${mergedTabs.length} unique tabs`, 'MERGE');

    await replaceLocalState(mergedTabs, mergedGroups);
}

// Tab Ordering
// Moves local tabs to match the index order from the remote state.
// Skips privileged tabs (extension pages, test bridge).
async function reorderTabs(remoteTabs) {
    const allTabs = await browser.tabs.query({ windowId: syncWindowId });
    const privilegedTabIds = new Set(allTabs.filter(t => isPrivilegedUrl(t.url)).map(t => t.id));

    // Map remote tabs to local IDs in remote order
    const targetSyncedOrder = [];
    for (const rt of remoteTabs) {
        const localId = SYNC_ID_TO_TAB_ID.get(rt.sId);
        if (localId !== undefined && !privilegedTabIds.has(localId)) {
            targetSyncedOrder.push(localId);
        }
    }

    if (targetSyncedOrder.length === 0) {
        return false;
    }

    // Put synced tabs in target order, skipping privileged tabs.
    // Re-query after each move since indices shift.
    let moved = false;
    for (let i = 0; i < targetSyncedOrder.length; i++) {
        const tabId = targetSyncedOrder[i];
        const freshTabs = await browser.tabs.query({ windowId: syncWindowId });

        // Find the index of the i-th non-privileged slot
        let syncedCount = 0;
        let targetIndex = freshTabs.length;
        for (const t of freshTabs) {
            if (!privilegedTabIds.has(t.id)) {
                if (syncedCount === i) {
                    targetIndex = t.index;
                    break;
                }
                syncedCount++;
            }
        }

        try {
            const tab = await browser.tabs.get(tabId);
            if (tab.index !== targetIndex) {
                await browser.tabs.move(tabId, { index: targetIndex });
                moved = true;
            }
        } catch (e) {
            // tab might be gone
        }
    }

    return moved;
}

// Replace Local State
// Overwrites the sync window's tabs and groups to match a target state (used by
// atomic merge). Existing tabs matching by URL are reused ("adopted"), the rest
// are created. Non-matching tabs get closed. All tabs are ungrouped, then
// target groups are recreated from scratch.

// Adopts existing tabs that match by URL, or creates new ones. Returns set of adopted tab IDs.
async function adoptOrCreateTabs(targetTabs, syncableTabs) {
    const adoptedTabIds = new Set();
    for (const tab of targetTabs) {
        const match = syncableTabs.find(lt =>
            !adoptedTabIds.has(lt.id) &&
            normalizeUrl(lt.url) === tab.url &&
            lt.pinned === (tab.pinned || false)
        );

        if (match) {
            adoptedTabIds.add(match.id);
            TAB_ID_TO_SYNC_ID.set(match.id, tab.sId);
            SYNC_ID_TO_TAB_ID.set(tab.sId, match.id);
            if (tab.muted && !(match.mutedInfo && match.mutedInfo.muted)) {
                try {
                    await browser.tabs.update(match.id, { muted: true });
                } catch (e) {
                    // tab might be gone
                }
            }
            fileLog(`Adopted existing tab: ${tab.url} (${tab.sId})`, 'REPLACE');
        } else {
            try {
                const newTab = await browser.tabs.create({
                    url: tab.url,
                    windowId: syncWindowId,
                    pinned: tab.pinned || false,
                    active: false
                });
                if (tab.muted) {
                    try {
                        await browser.tabs.update(newTab.id, { muted: true });
                    } catch (e) {
                        // tab might be gone
                    }
                }
                TAB_ID_TO_SYNC_ID.set(newTab.id, tab.sId);
                SYNC_ID_TO_TAB_ID.set(tab.sId, newTab.id);
                fileLog(`Created new tab: ${tab.url} (${tab.sId})`, 'REPLACE');
            } catch (e) {
                console.warn(`[REPLACE] Failed to create tab ${tab.url}:`, e.message);
            }
        }
    }
    return adoptedTabIds;
}

// Creates tab groups from target state (used during atomic replace).
async function createTargetGroups(targetTabs, targetGroups) {
    if (!browser.tabGroups || Object.keys(targetGroups).length === 0) {
        return;
    }
    try {
        const groupedTabs = {};
        for (const tab of targetTabs) {
            if (tab.groupSyncId && targetGroups[tab.groupSyncId]) {
                if (!groupedTabs[tab.groupSyncId]) {
                    groupedTabs[tab.groupSyncId] = [];
                }
                const localId = SYNC_ID_TO_TAB_ID.get(tab.sId);
                if (localId) {
                    groupedTabs[tab.groupSyncId].push(localId);
                }
            }
        }

        for (const [gSyncId, tabIds] of Object.entries(groupedTabs)) {
            if (tabIds.length === 0) {
                continue;
            }
            const groupInfo = targetGroups[gSyncId];
            try {
                const groupId = await browser.tabs.group({ tabIds });
                await browser.tabGroups.update(groupId, {
                    title: groupInfo.title || '',
                    color: groupInfo.color || 'grey'
                });
                GROUP_ID_TO_SYNC_ID.set(groupId, gSyncId);
                SYNC_ID_TO_GROUP_ID.set(gSyncId, groupId);
                localGroupChanges.set(gSyncId, groupInfo.lastModified || Date.now());
            } catch (e) {
                fileLog(`Failed to create group ${gSyncId}: ${e.message}`, 'REPLACE');
            }
        }
    } catch (e) {
        fileLog(`Group creation error: ${e.message}`, 'REPLACE');
    }
}

async function replaceLocalState(targetTabs, targetGroups = {}) {
    console.log(`[REPLACE] Replacing local state with ${targetTabs.length} tabs`);
    fileLog(`Replacing state: ${targetTabs.length} tabs`, 'REPLACE');

    const allTabs = await browser.tabs.query({ windowId: syncWindowId });
    const syncableTabs = allTabs.filter(t => !isPrivilegedUrl(t.url));

    // Clear mappings
    TAB_ID_TO_SYNC_ID.clear();
    SYNC_ID_TO_TAB_ID.clear();
    GROUP_ID_TO_SYNC_ID.clear();
    SYNC_ID_TO_GROUP_ID.clear();
    lastSeenGroupProps.clear();

    // Adopt existing tabs or create new ones
    const adoptedTabIds = await adoptOrCreateTabs(targetTabs, syncableTabs);

    // Close non-adopted, non-privileged tabs
    for (const tab of syncableTabs) {
        if (!adoptedTabIds.has(tab.id)) {
            try {
                await browser.tabs.remove(tab.id);
            } catch (e) {
                // tab might already be gone
            }
        }
    }

    // Reorder tabs to match remote ordering (must happen before grouping)
    await reorderTabs(targetTabs);

    // Ungroup ALL syncable tabs so stale Firefox groups don't interfere with
    // the fresh grouping below. Firefox can auto-group newly created tabs into
    // an adjacent existing group, so we need to clear everything first.
    if (browser.tabGroups) {
        const currentTabs = await browser.tabs.query({ windowId: syncWindowId });
        for (const tab of currentTabs) {
            if (!isPrivilegedUrl(tab.url) && tab.groupId !== undefined && tab.groupId !== -1) {
                try {
                    await browser.tabs.ungroup([tab.id]);
                } catch (e) {
                    // tab might be gone
                }
            }
        }
    }

    // Create tab groups
    await createTargetGroups(targetTabs, targetGroups);

    console.log(`[REPLACE] Done. ${TAB_ID_TO_SYNC_ID.size} tabs created.`);
    fileLog(`Replaced: ${TAB_ID_TO_SYNC_ID.size} tabs`, 'REPLACE');
}

// Incremental Sync (diff-based)
// Runs after the first sync with a peer. Compares incoming remote state against
// lastKnownRemoteState for that peer and applies only the differences: new tabs
// are created, changed URLs/properties are updated, removed tabs are closed,
// and group membership changes are applied.

// Picks up new and changed tabs from the remote. Returns { added, updated } counts.
async function syncAddedAndUpdatedTabs(remoteTabs, prevState, prevSyncIds) {
    const localTabs = await browser.tabs.query({ windowId: syncWindowId });
    const trackedTabIds = new Set(TAB_ID_TO_SYNC_ID.keys());
    let added = 0;
    let updated = 0;

    for (const rTab of remoteTabs) {
        if (!prevSyncIds.has(rTab.sId) && !SYNC_ID_TO_TAB_ID.has(rTab.sId)) {
            // New tab -- try to adopt an existing untracked tab with same URL
            let adopted = false;
            if (rTab.url && rTab.url !== 'about:blank') {
                const match = localTabs.find(lt =>
                    !trackedTabIds.has(lt.id) &&
                    !isPrivilegedUrl(lt.url) &&
                    normalizeUrl(lt.url) === rTab.url &&
                    lt.pinned === (rTab.pinned || false) &&
                    Math.abs(lt.index - (rTab.index || 0)) <= INDEX_MATCH_TOLERANCE
                );
                if (match) {
                    TAB_ID_TO_SYNC_ID.set(match.id, rTab.sId);
                    SYNC_ID_TO_TAB_ID.set(rTab.sId, match.id);
                    trackedTabIds.add(match.id);
                    fileLog(`Adopted existing tab: ${rTab.url} (${rTab.sId})`, 'SYNC');
                    adopted = true;
                }
            }

            if (!adopted) {
                try {
                    const newTab = await browser.tabs.create({
                        url: rTab.url,
                        windowId: syncWindowId,
                        pinned: rTab.pinned || false,
                        active: false
                    });
                    if (rTab.muted) {
                        try {
                            await browser.tabs.update(newTab.id, { muted: true });
                        } catch (e) {
                            // tab might be gone
                        }
                    }
                    TAB_ID_TO_SYNC_ID.set(newTab.id, rTab.sId);
                    SYNC_ID_TO_TAB_ID.set(rTab.sId, newTab.id);
                    fileLog(`Created tab: ${rTab.url} (${rTab.sId})`, 'SYNC');
                    added++;
                } catch (e) {
                    console.warn(`[SYNC] Failed to create tab ${rTab.url}:`, e.message);
                }
            }
        } else if (SYNC_ID_TO_TAB_ID.has(rTab.sId)) {
            // Existing tab -- check for property changes
            const localTabId = SYNC_ID_TO_TAB_ID.get(rTab.sId);
            const prevTab = prevState.get(rTab.sId);
            if (prevTab) {
                const updates = {};
                if (prevTab.url !== rTab.url && rTab.url !== 'about:blank') {
                    updates.url = rTab.url;
                }
                if (prevTab.pinned !== rTab.pinned) {
                    updates.pinned = rTab.pinned;
                }
                if (prevTab.muted !== rTab.muted) {
                    updates.muted = rTab.muted;
                }
                if (Object.keys(updates).length > 0) {
                    try {
                        await browser.tabs.update(localTabId, updates);
                        fileLog(`Updated tab: ${JSON.stringify(updates)} (${rTab.sId})`, 'SYNC');
                        updated++;
                    } catch (e) {
                        fileLog(`Tab gone during update (${rTab.sId}): ${e.message}`, 'SYNC');
                    }
                }
            }
        }
    }

    return { added, updated };
}

// Removes local tabs that the remote peer closed. Returns count of removed tabs.
async function syncRemovedTabs(prevState, currentRemoteSyncIds) {
    let removed = 0;
    let remainingTabCount = (await browser.tabs.query({ windowId: syncWindowId })).length;

    for (const [syncId] of prevState) {
        if (!currentRemoteSyncIds.has(syncId)) {
            const localTabId = SYNC_ID_TO_TAB_ID.get(syncId);
            if (localTabId) {
                try {
                    const tab = await browser.tabs.get(localTabId);
                    if (isPrivilegedUrl(tab.url)) {
                        fileLog(`Skipping removal of privileged tab: ${tab.url} (${syncId})`, 'SYNC');
                        TAB_ID_TO_SYNC_ID.delete(localTabId);
                        SYNC_ID_TO_TAB_ID.delete(syncId);
                        continue;
                    }
                } catch (e) {
                    fileLog(`Tab already gone during removal check (${syncId}): ${e.message}`, 'SYNC');
                    TAB_ID_TO_SYNC_ID.delete(localTabId);
                    SYNC_ID_TO_TAB_ID.delete(syncId);
                    continue;
                }
                if (remainingTabCount <= 1) {
                    fileLog(`Skipping tab removal - last tab protection: ${syncId}`, 'SYNC');
                    continue;
                }
                try {
                    await browser.tabs.remove(localTabId);
                    remainingTabCount--;
                    fileLog(`Removed tab closed by remote: ${syncId}`, 'SYNC');
                    removed++;
                } catch (e) {
                    // already gone
                }
                TAB_ID_TO_SYNC_ID.delete(localTabId);
                SYNC_ID_TO_TAB_ID.delete(syncId);
            }
        }
    }

    return removed;
}

// Syncs tab group assignments incrementally. Returns true if anything changed.
async function syncGroupsIncremental(remoteTabs, remoteGroups, prevState) {
    if (!browser.tabGroups || !remoteGroups) {
        return false;
    }
    let changed = false;

    try {
        for (const rTab of remoteTabs) {
            const localTabId = SYNC_ID_TO_TAB_ID.get(rTab.sId);
            if (!localTabId) {
                continue;
            }

            if (rTab.groupSyncId && remoteGroups[rTab.groupSyncId]) {
                // Tab should be in a group
                const gSyncId = rTab.groupSyncId;
                let localGroupId = SYNC_ID_TO_GROUP_ID.get(gSyncId);

                if (localGroupId === undefined) {
                    // Create new group
                    localGroupId = await browser.tabs.group({ tabIds: [localTabId] });
                    const groupInfo = remoteGroups[gSyncId];
                    await browser.tabGroups.update(localGroupId, {
                        title: groupInfo.title || '',
                        color: groupInfo.color || 'grey'
                    });
                    GROUP_ID_TO_SYNC_ID.set(localGroupId, gSyncId);
                    SYNC_ID_TO_GROUP_ID.set(gSyncId, localGroupId);
                    localGroupChanges.set(gSyncId, groupInfo.lastModified || Date.now());
                    changed = true;
                } else {
                    // Add tab to existing group if not already in it
                    try {
                        const tab = await browser.tabs.get(localTabId);
                        if (tab.groupId !== localGroupId) {
                            try {
                                await browser.tabs.group({ tabIds: [localTabId], groupId: localGroupId });
                                changed = true;
                            } catch (groupErr) {
                                // Group was probably destroyed by reorderTabs (tabs.move removes tabs from groups).
                                fileLog(`Group ${gSyncId} gone (destroyed by reorder?), recreating`, 'SYNC');
                                GROUP_ID_TO_SYNC_ID.delete(localGroupId);
                                SYNC_ID_TO_GROUP_ID.delete(gSyncId);
                                const groupInfo = remoteGroups[gSyncId];
                                localGroupId = await browser.tabs.group({ tabIds: [localTabId] });
                                await browser.tabGroups.update(localGroupId, {
                                    title: groupInfo.title || '',
                                    color: groupInfo.color || 'grey'
                                });
                                GROUP_ID_TO_SYNC_ID.set(localGroupId, gSyncId);
                                SYNC_ID_TO_GROUP_ID.set(gSyncId, localGroupId);
                                localGroupChanges.set(gSyncId, groupInfo.lastModified || Date.now());
                                changed = true;
                            }
                        }
                    } catch (e) {
                        // tab might be gone
                    }
                }

                // Update group properties if remote is newer (by timestamp only).
                // The sender bumps localGroupChanges via lastSeenGroupProps when
                // actual values change, so timestamps are always fresh.
                const groupInfo = remoteGroups[gSyncId];
                const localTimestamp = localGroupChanges.get(gSyncId) || 0;
                if (groupInfo.lastModified > localTimestamp) {
                    try {
                        await browser.tabGroups.update(localGroupId, {
                            title: groupInfo.title || '',
                            color: groupInfo.color || 'grey'
                        });
                        localGroupChanges.set(gSyncId, groupInfo.lastModified);
                    } catch (e) {
                        fileLog(`Failed to update group ${gSyncId}: ${e.message}`, 'SYNC');
                    }
                }
            } else {
                // Tab shouldn't be in a group according to remote.
                // Only ungroup if the remote PREVIOUSLY had this tab in a group
                // (intentional removal). If remote never knew about the group,
                // keep local state -- remote might not have our group info yet.
                const prevTab = prevState.get(rTab.sId);
                if (prevTab && prevTab.groupSyncId) {
                    try {
                        const tab = await browser.tabs.get(localTabId);
                        if (tab.groupId !== undefined && tab.groupId !== -1) {
                            await browser.tabs.ungroup([localTabId]);
                            changed = true;
                        }
                    } catch (e) {
                        fileLog(`Failed to ungroup tab (${rTab.sId}): ${e.message}`, 'SYNC');
                    }
                }
            }
        }
    } catch (e) {
        fileLog(`Group sync error: ${e.message}`, 'SYNC');
    }

    return changed;
}

// Returns a summary of what changed ({ changed, added, updated, removed }).
async function performIncrementalSync(remoteState) {
    const remotePeerId = remoteState.peerId;
    const remoteTabs = remoteState.tabs;
    const currentRemoteSyncIds = new Set(remoteTabs.map(t => t.sId));
    const remoteTabMap = new Map(remoteTabs.map(t => [t.sId, t]));

    const prevState = lastKnownRemoteState.get(remotePeerId) || new Map();
    const prevSyncIds = new Set(prevState.keys());

    fileLog(`Incremental sync: ${remoteTabs.length} remote tabs (prev: ${prevSyncIds.size})`, 'SYNC');

    const addUpdate = await syncAddedAndUpdatedTabs(remoteTabs, prevState, prevSyncIds);
    const removed = await syncRemovedTabs(prevState, currentRemoteSyncIds);

    const reordered = await reorderTabs(remoteTabs);

    const groupsChanged = await syncGroupsIncremental(remoteTabs, remoteState.groups, prevState);

    const changed = addUpdate.added > 0 || addUpdate.updated > 0 || removed > 0 || reordered || groupsChanged;

    lastKnownRemoteState.set(remotePeerId, remoteTabMap);
    return { changed, added: addUpdate.added, updated: addUpdate.updated, removed };
}

// Handle Remote State
// Entry point for all incoming sync data. If we're already processing, queues
// the incoming state (latest-per-peer) and works through the queue before
// releasing the lock. Prevents sync data loss when multiple peers broadcast
// at the same time.
async function handleSync(remoteState) {
    if (syncWindowId === null) {
        return;
    }
    if (syncPaused) {
        return;
    }
    if (!remoteState || !remoteState.tabs || !remoteState.peerId) {
        return;
    }
    if (remoteState.peerId === myDeviceId) {
        return;
    }

    if (isProcessingRemote) {
        // Queue it instead of dropping -- keep only latest per peer
        pendingSyncQueue = pendingSyncQueue.filter(s => s.peerId !== remoteState.peerId);
        pendingSyncQueue.push(remoteState);
        console.log(`[SYNC] Queued sync from ${remoteState.peerId} (processing busy)`);
        fileLog(`Queued sync from ${remoteState.peerId}`, 'SYNC');
        return;
    }

    isProcessingRemote = true;
    try {
        await processSyncData(remoteState);

        // Work through the queue while we hold the lock
        while (pendingSyncQueue.length > 0) {
            const next = pendingSyncQueue.shift();
            await processSyncData(next);
        }
    } catch (error) {
        console.error('[SYNC] Error:', error);
        fileLog(`Sync error: ${error.message}`, 'SYNC-ERROR');
    } finally {
        isProcessingRemote = false;
        if (broadcastPending) {
            broadcastPending = false;
            trigger(BROADCAST_DEBOUNCE_MS);
        }
    }
}

// Handles one remote state update. Called by handleSync() with the
// isProcessingRemote lock held. Validates, then routes to atomic merge
// (first contact) or incremental sync (subsequent updates).
async function processSyncData(remoteState) {
    if (remoteState.timestamp <= lastRemoteSyncTime) {
        return;
    }

    // Validate and clean up the incoming remote state
    const validated = validateRemoteState(remoteState);
    if (!validated) {
        return;
    }
    remoteState = validated;

    const hasBeenSynced = syncedPeers.has(remoteState.peerId);
    const hasPriorState = lastKnownRemoteState.has(remoteState.peerId);
    // Fall back to atomic merge if we lost our diffing state (e.g. after restart)
    const isFirstSync = !hasBeenSynced || !hasPriorState;

    if (isFirstSync) {
        syncCounter++;
        const reason = !hasBeenSynced ? 'new peer' : 'lost prior state (restart?)';
        console.log(`[SYNC] First sync with ${remoteState.peerId} - atomic merge (${reason})`);
        fileLog(`First sync with ${remoteState.peerId} (${reason})`, 'SYNC');

        // See if the remote already merged with us
        // (their state contains our sync IDs)
        const mySyncIds = new Set(TAB_ID_TO_SYNC_ID.values());
        const remoteSyncIds = new Set(remoteState.tabs.map(t => t.sId));
        const overlap = [...mySyncIds].filter(id => remoteSyncIds.has(id));
        const remoteAlreadyMerged = mySyncIds.size > 0 && overlap.length === mySyncIds.size;

        const localTabsBefore = TAB_ID_TO_SYNC_ID.size;

        if (remoteAlreadyMerged) {
            // Remote already has all our tabs, just adopt their state
            console.log(`[SYNC] Remote already merged with us - adopting their state`);
            fileLog(`Remote already merged - adopting ${remoteState.tabs.length} tabs`, 'SYNC');
            await replaceLocalState(remoteState.tabs, remoteState.groups || {});
        } else {
            // Normal atomic merge
            const myState = await captureLocalState();
            await performAtomicMerge(myState, remoteState);
        }

        const localTabsAfter = TAB_ID_TO_SYNC_ID.size;
        syncHistory.push({
            time: Date.now(),
            peer: remoteState.peerId,
            type: remoteAlreadyMerged ? 'adopted' : 'merge',
            remoteTabs: remoteState.tabs.length,
            added: Math.max(0, localTabsAfter - localTabsBefore),
            updated: 0,
            removed: 0,
        });
        if (syncHistory.length > MAX_SYNC_HISTORY) {
            syncHistory.shift();
        }

        syncedPeers.add(remoteState.peerId);
        await browser.storage.local.set({ syncedPeers: Array.from(syncedPeers) });

        // Set up tracking for this peer so future diffs work
        const remoteTabMap = new Map(remoteState.tabs.map(t => [t.sId, t]));
        lastKnownRemoteState.set(remoteState.peerId, remoteTabMap);

        // Send the merged state back so the other peer picks it up
        trigger(BROADCAST_AFTER_SYNC_MS);
    } else {
        // Incremental diff-based sync
        console.log(`[SYNC] Incremental sync from ${remoteState.peerId}: ${remoteState.tabs.length} tabs`);
        const result = await performIncrementalSync(remoteState);

        syncHistory.push({
            time: Date.now(),
            peer: remoteState.peerId,
            type: 'incremental',
            remoteTabs: remoteState.tabs.length,
            added: result.added,
            updated: result.updated,
            removed: result.removed,
        });
        if (syncHistory.length > MAX_SYNC_HISTORY) {
            syncHistory.shift();
        }

        if (result.changed) {
            syncCounter++;
            // Only re-broadcast if we actually made local changes
            trigger(BROADCAST_AFTER_SYNC_MS);
        }
    }

    lastRemoteSyncTime = remoteState.timestamp;
}

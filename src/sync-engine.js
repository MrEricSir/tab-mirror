// Tracks the last-seen title+color per group sync ID so captureLocalState() can
// detect changes even when tabGroups.onUpdated doesn't fire (cross-extension
// issue on Linux headless Firefox).
const lastSeenGroupProps = new Map(); // gSyncId -> { title, color }

// Returns maps for resolving container identities by cookieStoreId and by name.
async function getContainerMap() {
    if (!browser.contextualIdentities) {
        return { byId: new Map(), byName: new Map() };
    }
    try {
        const identities = await browser.contextualIdentities.query({});
        const byId = new Map();   // cookieStoreId -> name
        const byName = new Map(); // name -> cookieStoreId
        for (const ci of identities) {
            byId.set(ci.cookieStoreId, ci.name);
            if (!byName.has(ci.name)) {
                byName.set(ci.name, ci.cookieStoreId);
            }
        }
        return { byId, byName };
    } catch (e) {
        return { byId: new Map(), byName: new Map() };
    }
}

// Check if a local tab's container matches the expected remote container.
// Returns true if containers are compatible for adoption.
function isContainerMatch(localTab, remoteTab, containerMap) {
    const localStore = localTab.cookieStoreId || 'firefox-default';
    if (!remoteTab.containerName) {
        // Remote tab is in default container; local must be too
        return localStore === 'firefox-default';
    }
    // Remote tab has a container; local must be in the same one
    const expectedStore = containerMap.byName.get(remoteTab.containerName);
    return expectedStore !== undefined && localStore === expectedStore;
}

// Pure: find an existing untracked local tab matching a remote tab based
// on its properties.
function findMatchingLocalTab(localTabs, remoteTab, trackedTabIds, indexTolerance) {
    if (!remoteTab.url || remoteTab.url === 'about:blank') return null;
    return localTabs.find(lt =>
        !trackedTabIds.has(lt.id) &&
        !isPrivilegedUrl(lt.url) &&
        normalizeUrl(lt.url) === remoteTab.url &&
        lt.pinned === (remoteTab.pinned || false) &&
        Math.abs(lt.index - (remoteTab.index || 0)) <= indexTolerance
    ) || null;
}

// Build tab groupping map, format: { gSyncId: [localTabId, ...] }
function buildTabGroupingMap(targetTabs, targetGroups, syncIdToTabIdMap) {
    const groupedTabs = {};
    for (const tab of targetTabs) {
        if (tab.groupSyncId && targetGroups[tab.groupSyncId]) {
            if (!groupedTabs[tab.groupSyncId]) {
                groupedTabs[tab.groupSyncId] = [];
            }
            const localId = syncIdToTabIdMap.get(tab.sId);
            if (localId) {
                groupedTabs[tab.groupSyncId].push(localId);
            }
        }
    }
    return groupedTabs;
}

// Pure: match live tabs to persisted sync ID mappings by url+pinned.
// Returns { matched: [{tabId, sId}], unmatched: [{sId, url, pinned}] }
// Greedy: each live tab matched at most once.
function matchTabsToMappings(liveTabs, persistedMappings) {
    const matched = [];
    const usedTabIds = new Set();

    for (const mapping of persistedMappings) {
        const match = liveTabs.find(t =>
            !usedTabIds.has(t.id) &&
            t.url === mapping.url &&
            t.pinned === mapping.pinned
        );
        if (match) {
            matched.push({ tabId: match.id, sId: mapping.sId });
            usedTabIds.add(match.id);
        }
    }

    const matchedSids = new Set(matched.map(m => m.sId));
    const unmatched = persistedMappings.filter(m => !matchedSids.has(m.sId));

    return { matched, unmatched };
}

// Capture Local State
// Grabs all syncable tabs and groups from the sync window. Each tab and group
// gets a stable sync ID if it doesn't have one yet. The result is the payload
// we send to peers via broadcastState().
async function captureLocalState() {
    const tabs = await browser.tabs.query({ windowId: syncWindowId });

    let syncableTabs = tabs
        .map(t => ({ ...t, url: normalizeUrl(t.url) }))
        .filter(t => isSyncableUrl(t.url));

    // Container tab handling
    const containerMap = syncContainerTabs ? await getContainerMap() : null;
    if (!syncContainerTabs) {
        // Filter out container tabs entirely when the toggle is off
        syncableTabs = syncableTabs.filter(t =>
            !t.cookieStoreId || t.cookieStoreId === 'firefox-default'
        );
    }

    // Cap outgoing tabs to match receiver limit
    if (syncableTabs.length > MAX_REMOTE_TABS) {
        console.warn(`[BROADCAST] Capping outgoing tabs: ${syncableTabs.length} -> ${MAX_REMOTE_TABS}`);
        syncableTabs = syncableTabs.slice(0, MAX_REMOTE_TABS);
    }

    // Grab group data if the API is available
    let groupData = {};
    if (browser.tabGroups) {
        try {
            const groups = await browser.tabGroups.query({ windowId: syncWindowId });
            for (const group of groups) {
                let gSyncId = groupSyncIds.getByA(group.id);
                if (!gSyncId) {
                    gSyncId = generateSyncId('gsid_');
                    groupSyncIds.set(group.id, gSyncId);
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
        let sId = tabSyncIds.getByA(t.id);
        if (!sId) {
            sId = generateSyncId('sid_');
            tabSyncIds.set(t.id, sId);
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
            const gSyncId = groupSyncIds.getByA(t.groupId);
            if (gSyncId) {
                tabInfo.groupSyncId = gSyncId;
            }
        }
        // Add container name for non-default containers
        if (containerMap && t.cookieStoreId && t.cookieStoreId !== 'firefox-default') {
            const name = containerMap.byId.get(t.cookieStoreId);
            if (name) {
                tabInfo.containerName = name;
            }
        }
        // Pre-sync URL revert suppression: if this tab's current URL matches the
        // pre-sync URL (redirect artifact), override with what sync intended so
        // the revert doesn't propagate via captureLocalState broadcasts.
        const pre = preSyncUrls.get(sId);
        if (pre && (Date.now() - pre.at) < PRE_SYNC_REVERT_WINDOW_MS) {
            if (normalizeUrl(t.url) === pre.preSyncUrl) {
                tabInfo.url = pre.appliedUrl;
            }
        } else if (pre) {
            preSyncUrls.delete(sId);
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
        // If the sync window just changed, flag the broadcast so peers
        // reset to atomic merge instead of incremental diff.
        if (syncWindowChanged) {
            state.syncWindowChanged = true;
            syncWindowChanged = false;
        }
        console.log(`[BROADCAST] ${state.tabs.length} tabs to ${connections.size} peer(s)${state.syncWindowChanged ? ' (window changed)' : ''}`);
        fileLog(`Broadcasting ${state.tabs.length} tabs${state.syncWindowChanged ? ' (window changed)' : ''}`, 'BROADCAST');

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
                    cleanupPeerConnection(peerId);
                }
            }
        }
        broadcastStats.completed++;
        persistSyncState(state.tabs).catch(e => {
            console.warn('[PERSIST] Failed to persist sync state:', e.message);
        });
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

// Helper function for performAtomicMerge()
// Exported for unit testing.
function computeAtomicMerge(localState, remoteState, myDeviceId) {
    // Higher peer ID goes first (keeps merge order stable)
    const iAmFirst = myDeviceId > remoteState.peerId;
    const firstState = iAmFirst ? localState : remoteState;
    const secondState = iAmFirst ? remoteState : localState;

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
                continue;
            }
        }

        mergedTabs.push(tab);
    }

    // Merge groups (union of both group sets)
    const mergedGroups = { ...(firstState.groups || {}), ...(secondState.groups || {}) };

    return { tabs: mergedTabs, groups: mergedGroups };
}

// Merge Algorithm
//
// Combines two sets of tab into one result. To make this deterministic, higher
// peer ID  tabs go first, then the lower ones.
//
// To dedupe tabs, we first go through based on sync ID, then by URL+pinned
// combo.
//
// Groups are stabalized by taking the union.
async function performAtomicMerge(myState, remoteState) {
    console.log(`[MERGE] Atomic merge with ${remoteState.peerId}`);
    fileLog(`=== ATOMIC MERGE with ${remoteState.peerId} ===`, 'MERGE');

    const merged = computeAtomicMerge(myState, remoteState, myDeviceId);

    console.log(`[MERGE] Result: ${merged.tabs.length} tabs`);
    fileLog(`Merged: ${merged.tabs.length} unique tabs`, 'MERGE');

    await replaceLocalState(merged.tabs, merged.groups);
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
        const localId = tabSyncIds.getByB(rt.sId);
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
                const groupBefore = tab.groupId;
                await browser.tabs.move(tabId, { index: targetIndex });
                moved = true;
                // Firefox may auto-group a tab when moving it into a group's range.
                // Revert the side effect; correct grouping happens in syncGroupsIncremental().
                if (browser.tabGroups) {
                    const tabAfter = await browser.tabs.get(tabId);
                    if (tabAfter.groupId !== groupBefore &&
                        tabAfter.groupId !== undefined &&
                        tabAfter.groupId !== -1) {
                        await browser.tabs.ungroup([tabId]);
                    }
                }
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
    const containerMap = await getContainerMap();
    for (const tab of targetTabs) {
        const match = syncableTabs.find(lt =>
            !adoptedTabIds.has(lt.id) &&
            normalizeUrl(lt.url) === tab.url &&
            lt.pinned === (tab.pinned || false) &&
            isContainerMatch(lt, tab, containerMap)
        );

        if (match) {
            adoptedTabIds.add(match.id);
            tabSyncIds.set(match.id, tab.sId);
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
                const createOpts = {
                    url: tab.url,
                    windowId: syncWindowId,
                    pinned: tab.pinned || false,
                    active: false
                };
                // Resolve container by name
                if (tab.containerName) {
                    const storeId = containerMap.byName.get(tab.containerName);
                    if (storeId) {
                        createOpts.cookieStoreId = storeId;
                    }
                }
                const newTab = await browser.tabs.create(createOpts);
                if (tab.muted) {
                    try {
                        await browser.tabs.update(newTab.id, { muted: true });
                    } catch (e) {
                        // tab might be gone
                    }
                }
                tabSyncIds.set(newTab.id, tab.sId);
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
        const groupedTabs = buildTabGroupingMap(targetTabs, targetGroups, { get: (sId) => tabSyncIds.getByB(sId) });

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
                groupSyncIds.set(groupId, gSyncId);
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
    tabSyncIds.clear();
    clearGroupState();

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

    // Snapshot collapsed groups before ungrouping. Groups are destroyed and
    // recreated below, so we remember collapsed state by title+color and
    // restore it after recreation.
    const collapsedGroups = new Set();
    if (browser.tabGroups) {
        try {
            const existingGroups = await browser.tabGroups.query({ windowId: syncWindowId });
            for (const g of existingGroups) {
                if (g.collapsed) {
                    collapsedGroups.add(`${g.title || ''}|${g.color || 'grey'}`);
                }
            }
        } catch (e) {
            // tabGroups API might not work
        }
    }

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

    // Restore collapsed state for recreated groups
    if (collapsedGroups.size > 0 && browser.tabGroups) {
        try {
            const newGroups = await browser.tabGroups.query({ windowId: syncWindowId });
            for (const g of newGroups) {
                const key = `${g.title || ''}|${g.color || 'grey'}`;
                if (collapsedGroups.has(key)) {
                    await browser.tabGroups.update(g.id, { collapsed: true });
                }
            }
        } catch (e) {
            // best-effort
        }
    }

    console.log(`[REPLACE] Done. ${tabSyncIds.size} tabs created.`);
    fileLog(`Replaced: ${tabSyncIds.size} tabs`, 'REPLACE');
}

// Pure Remote Diff
// Compares incoming remote tabs against the previous snapshot to compute what
// changed: added tabs, updated tabs (url/pinned/muted changes), and removed
// sync IDs. No browser API calls -- pure data in, pure data out.
function computeRemoteDiff(remoteTabs, prevRemoteState) {
    const added = [];
    const updated = [];
    const removed = [];

    const currentSyncIds = new Set();

    for (const rTab of remoteTabs) {
        currentSyncIds.add(rTab.sId);
        const prevTab = prevRemoteState.get(rTab.sId);

        if (!prevTab) {
            added.push(rTab);
        } else {
            const changes = {};
            if (prevTab.url !== rTab.url) {
                changes.url = rTab.url;
            }
            if (prevTab.pinned !== rTab.pinned) {
                changes.pinned = rTab.pinned;
            }
            if (prevTab.muted !== rTab.muted) {
                changes.muted = rTab.muted;
            }
            if (Object.keys(changes).length > 0) {
                updated.push({ sId: rTab.sId, changes, tab: rTab });
            }
        }
    }

    for (const [syncId] of prevRemoteState) {
        if (!currentSyncIds.has(syncId)) {
            removed.push(syncId);
        }
    }

    return { added, updated, removed };
}

// Incremental Sync (diff-based)
// Runs after the first sync with a peer. Compares incoming remote state against
// lastKnownRemoteState for that peer and applies only the differences: new tabs
// are created, changed URLs/properties are updated, removed tabs are closed,
// and group membership changes are applied.

// Picks up new and changed tabs from the remote. Returns { added, updated } counts.
// diff parameter: Output from computeRemoteDiff()
async function syncAddedAndUpdatedTabs(remoteTabs, prevState, diff) {
    const localTabs = await browser.tabs.query({ windowId: syncWindowId });
    const trackedTabIds = new Set(tabSyncIds.keys());
    const containerMap = await getContainerMap();
    let added = 0;
    let updated = 0;

    // Process added tabs
    for (const rTab of diff.added) {
        if (tabSyncIds.hasB(rTab.sId)) {
            continue; // already tracked locally
        }

        // Try to adopt an existing untracked tab with same URL and container
        let adopted = false;
        {
            const match = findMatchingLocalTab(localTabs, rTab, trackedTabIds, INDEX_MATCH_TOLERANCE);
            if (match && isContainerMatch(match, rTab, containerMap)) {
                tabSyncIds.set(match.id, rTab.sId);
                trackedTabIds.add(match.id);
                fileLog(`Adopted existing tab: ${rTab.url} (${rTab.sId})`, 'SYNC');
                adopted = true;
            }
        }

        if (!adopted) {
            try {
                const createOpts = {
                    url: rTab.url,
                    windowId: syncWindowId,
                    pinned: rTab.pinned || false,
                    active: false
                };
                // Resolve container by name
                if (rTab.containerName) {
                    const storeId = containerMap.byName.get(rTab.containerName);
                    if (storeId) {
                        createOpts.cookieStoreId = storeId;
                    }
                }
                const newTab = await browser.tabs.create(createOpts);
                if (rTab.muted) {
                    try {
                        await browser.tabs.update(newTab.id, { muted: true });
                    } catch (e) {
                        // tab might be gone
                    }
                }
                tabSyncIds.set(newTab.id, rTab.sId);
                // Record for redirect suppression
                recentlySyncedUrls.set(rTab.sId, { url: rTab.url, at: Date.now() });
                fileLog(`Created tab: ${rTab.url} (${rTab.sId})`, 'SYNC');
                added++;
            } catch (e) {
                console.warn(`[SYNC] Failed to create tab ${rTab.url}:`, e.message);
            }
        }
    }

    // Process updated tabs
    for (const { sId, changes, tab: rTab } of diff.updated) {
        if (!tabSyncIds.hasB(sId)) {
            continue;
        }
        const localTabId = tabSyncIds.getByB(sId);
        const updates = { ...changes };

        // Only update URL if the local tab doesn't already have it.
        // Without this check, when B echoes A's URL back, A would
        // redundantly record a recentlySyncedUrls entry that suppresses
        // subsequent user navigation on A.
        if (updates.url) {
            if (updates.url === 'about:blank') {
                delete updates.url;
            } else {
                const localTab = localTabs.find(t => t.id === localTabId);
                if (localTab && normalizeUrl(localTab.url) === rTab.url) {
                    delete updates.url;
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            try {
                // Record the local tab's current URL before sync changes it,
                // so we can suppress redirect-induced reverts back to this URL.
                if (updates.url) {
                    const localTab = localTabs.find(t => t.id === localTabId);
                    if (localTab) {
                        preSyncUrls.set(sId, {
                            preSyncUrl: normalizeUrl(localTab.url),
                            appliedUrl: updates.url,
                            at: Date.now()
                        });
                    }
                }
                await browser.tabs.update(localTabId, updates);
                if (updates.url) {
                    recentlySyncedUrls.set(sId, { url: updates.url, at: Date.now() });
                }
                fileLog(`Updated tab: ${JSON.stringify(updates)} (${sId})`, 'SYNC');
                updated++;
            } catch (e) {
                fileLog(`Tab gone during update (${sId}): ${e.message}`, 'SYNC');
            }
        }
    }

    return { added, updated };
}

// Removes local tabs that the remote peer closed. Returns count of removed tabs.
// Takes removedSyncIds array from computeRemoteDiff().
async function syncRemovedTabs(removedSyncIds) {
    let removed = 0;
    let remainingTabCount = (await browser.tabs.query({ windowId: syncWindowId })).length;

    for (const syncId of removedSyncIds) {
        const localTabId = tabSyncIds.getByB(syncId);
        if (localTabId) {
            try {
                const tab = await browser.tabs.get(localTabId);
                if (isPrivilegedUrl(tab.url)) {
                    fileLog(`Skipping removal of privileged tab: ${tab.url} (${syncId})`, 'SYNC');
                    tabSyncIds.deleteByB(syncId);
                    continue;
                }
            } catch (e) {
                fileLog(`Tab already gone during removal check (${syncId}): ${e.message}`, 'SYNC');
                tabSyncIds.deleteByB(syncId);
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
            tabSyncIds.deleteByB(syncId);
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
            const localTabId = tabSyncIds.getByB(rTab.sId);
            if (!localTabId) {
                continue;
            }

            if (rTab.groupSyncId && remoteGroups[rTab.groupSyncId]) {
                // Tab should be in a group
                const gSyncId = rTab.groupSyncId;
                let localGroupId = groupSyncIds.getByB(gSyncId);

                if (localGroupId === undefined) {
                    // Create new group
                    localGroupId = await browser.tabs.group({ tabIds: [localTabId] });
                    const groupInfo = remoteGroups[gSyncId];
                    await browser.tabGroups.update(localGroupId, {
                        title: groupInfo.title || '',
                        color: groupInfo.color || 'grey'
                    });
                    groupSyncIds.set(localGroupId, gSyncId);
                    localGroupChanges.set(gSyncId, groupInfo.lastModified || Date.now());
                    changed = true;
                } else {
                    // Add tab to existing group if not already in it
                    try {
                        const tab = await browser.tabs.get(localTabId);
                        if (tab.groupId !== localGroupId) {
                            // Preserve collapsed state when new tab is added to a collapsed
                            // tab group via sync.
                            let wasCollapsed = false;
                            try {
                                const groupState = await browser.tabGroups.get(localGroupId);
                                wasCollapsed = groupState.collapsed;
                            } catch (e) {
                                // group might be gone
                            }
                            try {
                                await browser.tabs.group({ tabIds: [localTabId], groupId: localGroupId });
                                if (wasCollapsed) {
                                    await browser.tabGroups.update(localGroupId, { collapsed: true });
                                }
                                changed = true;
                            } catch (groupErr) {
                                // Group was probably destroyed by reorderTabs (tabs.move removes tabs from groups).
                                fileLog(`Group ${gSyncId} gone (destroyed by reorder?), recreating`, 'SYNC');
                                groupSyncIds.deleteByB(gSyncId);
                                const groupInfo = remoteGroups[gSyncId];
                                localGroupId = await browser.tabs.group({ tabIds: [localTabId] });
                                await browser.tabGroups.update(localGroupId, {
                                    title: groupInfo.title || '',
                                    color: groupInfo.color || 'grey',
                                    collapsed: wasCollapsed
                                });
                                groupSyncIds.set(localGroupId, gSyncId);
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
    const remoteTabMap = new Map(remoteTabs.map(t => [t.sId, t]));

    const prevState = lastKnownRemoteState.get(remotePeerId) || new Map();
    const diff = computeRemoteDiff(remoteTabs, prevState);

    fileLog(`Incremental sync: ${remoteTabs.length} remote tabs (prev: ${prevState.size})`, 'SYNC');

    const addUpdate = await syncAddedAndUpdatedTabs(remoteTabs, prevState, diff);
    const removed = await syncRemovedTabs(diff.removed);

    // Snapshot collapsed group IDs before reorder + group sync.
    // tabs.move() and tabs.group() can both disturb Firefox's collapsed state.
    const collapsedGroupIds = new Set();
    if (browser.tabGroups) {
        try {
            const groups = await browser.tabGroups.query({ windowId: syncWindowId });
            for (const g of groups) {
                if (g.collapsed) {
                    collapsedGroupIds.add(g.id);
                }
            }
        } catch (e) {
            // tabGroups API might not work
        }
    }

    const reordered = await reorderTabs(remoteTabs);

    const groupsChanged = await syncGroupsIncremental(remoteTabs, remoteState.groups, prevState);

    // Reorder if tab groups have changed to maintain a stable order.
    if (groupsChanged) {
        await reorderTabs(remoteTabs);
    }

    // Restore collapsed state for any groups that got expanded by
    // tabs.move() or tabs.group() during the reorder/group sync above.
    if (collapsedGroupIds.size > 0 && browser.tabGroups) {
        try {
            const groupsAfter = await browser.tabGroups.query({ windowId: syncWindowId });
            for (const g of groupsAfter) {
                if (collapsedGroupIds.has(g.id) && !g.collapsed) {
                    await browser.tabGroups.update(g.id, { collapsed: true });
                }
            }
        } catch (e) {
            // best-effort
        }
    }

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
            trigger(BROADCAST_DEBOUNCE_FAST_MS);
        }
    }
}

// Handles one remote state update. Called by handleSync() with the
// isProcessingRemote lock held. Validates, then routes to atomic merge
// (first contact) or incremental sync (subsequent updates).
async function processSyncData(remoteState) {
    const peerLastTime = lastRemoteSyncTime.get(remoteState.peerId) || 0;
    if (remoteState.timestamp <= peerLastTime) {
        return;
    }

    // Validate and clean up the incoming remote state
    const validated = validateRemoteState(remoteState);
    if (!validated) {
        return;
    }
    remoteState = validated;

    // If the remote peer switched sync windows, reset our tracking for them
    // so we fall into atomic merge instead of incremental diff.
    if (remoteState.syncWindowChanged) {
        console.log(`[SYNC] Peer ${remoteState.peerId} changed sync window - resetting to atomic merge`);
        fileLog(`Peer ${remoteState.peerId} changed sync window`, 'SYNC');
        lastKnownRemoteState.delete(remoteState.peerId);
        syncedPeers.delete(remoteState.peerId);
    }

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
        const mySyncIds = new Set(tabSyncIds.values());
        const remoteSyncIds = new Set(remoteState.tabs.map(t => t.sId));
        const overlap = [...mySyncIds].filter(id => remoteSyncIds.has(id));
        const remoteAlreadyMerged = mySyncIds.size > 0 && overlap.length === mySyncIds.size;

        const localTabsBefore = tabSyncIds.size;

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

        const localTabsAfter = tabSyncIds.size;
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

        // Remove tabs that were deleted while offline (tombstone cleanup)
        if (offlineTombstones.size > 0) {
            await applyTombstones();
        }
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

    lastRemoteSyncTime.set(remoteState.peerId, remoteState.timestamp);
}

// Persist sync state to storage after each successful broadcast.
async function persistSyncState(broadcastTabs) {
    const syncIdMappings = broadcastTabs.map(t => ({
        sId: t.sId,
        url: t.url,
        pinned: t.pinned
    }));

    const lastBroadcastTabs = broadcastTabs.map(t => ({
        sId: t.sId,
        url: t.url,
        pinned: t.pinned
    }));

    // Serialize group mappings
    const groupSyncIdMappings = [];
    for (const [groupId, gSyncId] of groupSyncIds) {
        const props = lastSeenGroupProps.get(gSyncId);
        if (props) {
            groupSyncIdMappings.push({
                gSyncId,
                title: props.title,
                color: props.color
            });
        }
    }

    // Serialize per-peer remote state
    const peerRemoteStates = {};
    for (const [peerId, tabMap] of lastKnownRemoteState) {
        peerRemoteStates[peerId] = Array.from(tabMap.values());
    }

    await browser.storage.local.set({
        syncIdMappings,
        groupSyncIdMappings,
        lastBroadcastTabs,
        peerRemoteStates
    });
}

// Restore sync ID mappings from storage at boot.
// Returns tombstone keys (Set of "url|pinned") for tabs deleted while offline.
async function restoreSyncMappings() {
    let result;
    try {
        result = await browser.storage.local.get([
            'syncIdMappings', 'groupSyncIdMappings', 'lastBroadcastTabs'
        ]);
    } catch (e) {
        console.warn('[RESTORE] Failed to load sync mappings:', e.message);
        return;
    }

    const persistedMappings = result.syncIdMappings;
    if (!Array.isArray(persistedMappings) || persistedMappings.length === 0) {
        return;
    }

    // Query current live tabs in sync window
    const allTabs = await browser.tabs.query({ windowId: syncWindowId });
    const liveTabs = allTabs
        .map(t => ({ id: t.id, url: normalizeUrl(t.url), pinned: t.pinned }))
        .filter(t => isSyncableUrl(t.url));

    // Match live tabs to persisted mappings
    const { matched, unmatched } = matchTabsToMappings(liveTabs, persistedMappings);

    // Restore tab sync ID mappings
    for (const { tabId, sId } of matched) {
        tabSyncIds.set(tabId, sId);
    }

    console.log(`[RESTORE] Restored ${matched.length} tab mappings (${unmatched.length} unmatched)`);
    fileLog(`Restored ${matched.length} tab mappings, ${unmatched.length} unmatched`, 'RESTORE');

    // Restore group mappings
    const persistedGroups = result.groupSyncIdMappings;
    if (Array.isArray(persistedGroups) && persistedGroups.length > 0 && browser.tabGroups) {
        try {
            const liveGroups = await browser.tabGroups.query({ windowId: syncWindowId });
            const usedGroupIds = new Set();

            for (const pg of persistedGroups) {
                const match = liveGroups.find(g =>
                    !usedGroupIds.has(g.id) &&
                    (g.title || '') === pg.title &&
                    (g.color || 'grey') === pg.color
                );
                if (match) {
                    groupSyncIds.set(match.id, pg.gSyncId);
                    lastSeenGroupProps.set(pg.gSyncId, { title: pg.title, color: pg.color });
                    usedGroupIds.add(match.id);
                }
            }

            console.log(`[RESTORE] Restored ${usedGroupIds.size} group mappings`);
        } catch (e) {
            // tabGroups API might not work
        }
    }

    // Compute tombstones: persisted broadcast tabs whose url|pinned has no live match
    const lastBroadcast = result.lastBroadcastTabs;
    if (Array.isArray(lastBroadcast) && lastBroadcast.length > 0) {
        const liveKeys = new Map(); // "url|pinned" -> count
        for (const t of liveTabs) {
            const key = `${t.url}|${t.pinned}`;
            liveKeys.set(key, (liveKeys.get(key) || 0) + 1);
        }

        // Consume live tabs against broadcast tabs; leftovers are tombstones
        const broadcastKeys = new Map(); // "url|pinned" -> count
        for (const t of lastBroadcast) {
            const key = `${t.url}|${t.pinned}`;
            broadcastKeys.set(key, (broadcastKeys.get(key) || 0) + 1);
        }

        for (const [key, broadcastCount] of broadcastKeys) {
            const liveCount = liveKeys.get(key) || 0;
            if (liveCount < broadcastCount) {
                offlineTombstones.add(key);
            }
        }

        if (offlineTombstones.size > 0) {
            console.log(`[RESTORE] Computed ${offlineTombstones.size} offline tombstones`);
            fileLog(`Computed ${offlineTombstones.size} offline tombstones`, 'RESTORE');
        }
    }
}

// Restore per-peer remote state from storage at boot.
async function restoreRemoteStates() {
    let result;
    try {
        result = await browser.storage.local.get('peerRemoteStates');
    } catch (e) {
        console.warn('[RESTORE] Failed to load remote states:', e.message);
        return;
    }

    const stored = result.peerRemoteStates;
    if (!stored || typeof stored !== 'object') {
        return;
    }

    let restored = 0;
    for (const [peerId, tabs] of Object.entries(stored)) {
        if (Array.isArray(tabs)) {
            const tabMap = new Map(tabs.map(t => [t.sId, t]));
            lastKnownRemoteState.set(peerId, tabMap);
            restored++;
        }
    }

    if (restored > 0) {
        console.log(`[RESTORE] Restored remote state for ${restored} peer(s)`);
        fileLog(`Restored remote state for ${restored} peer(s)`, 'RESTORE');
    }
}

// Apply tombstones after atomic merge: close tabs that were deleted while offline.
async function applyTombstones() {
    if (offlineTombstones.size === 0) {
        return;
    }

    const allTabs = await browser.tabs.query({ windowId: syncWindowId });
    const syncableTabs = allTabs.filter(t => !isPrivilegedUrl(t.url));
    let remainingCount = allTabs.length;
    let removed = 0;

    for (const tab of syncableTabs) {
        const key = `${normalizeUrl(tab.url)}|${tab.pinned}`;
        if (offlineTombstones.has(key)) {
            if (remainingCount <= 1) {
                fileLog(`Skipping tombstone removal - last tab protection`, 'TOMBSTONE');
                continue;
            }
            try {
                await browser.tabs.remove(tab.id);
                remainingCount--;
                removed++;
                // Clean up sync ID mappings
                const sId = tabSyncIds.getByA(tab.id);
                if (sId) {
                    tabSyncIds.deleteByA(tab.id);
                }
                fileLog(`Tombstone removed tab: ${tab.url} (pinned=${tab.pinned})`, 'TOMBSTONE');
            } catch (e) {
                // tab might already be gone
            }
        }
    }

    if (removed > 0) {
        console.log(`[TOMBSTONE] Removed ${removed} tombstoned tab(s)`);
        fileLog(`Removed ${removed} tombstoned tab(s)`, 'TOMBSTONE');
    }

    offlineTombstones.clear();
}

if (typeof module !== 'undefined') {
    module.exports = { computeAtomicMerge, computeRemoteDiff, findMatchingLocalTab, buildTabGroupingMap, matchTabsToMappings };
}

/**
 * Tab Mirror
 *
 * Synchronizes browser tabs across devices over PeerJS.
 *
 * Sync lifecycle:
 *   Peers are discovered via listAllPeers() (test) or a paired device list
 *   (production). The lower ID peer dials the higher ID peer. Production
 *   connections are authenticated via HMAC challenge/response.
 *
 *   On first contact, an atomic merge combines both peers' tabs and groups
 *   into a single deterministic result. Subsequent updates are handled by
 *   incremental diff sync, which adds, updates, and removes individual tabs.
 *
 *   Local tab/group changes are debounced through trigger() and broadcast to
 *   all connected peers. Broadcasts are serialized (one in flight at a time)
 *   and deferred while processing incoming remote state.
 *
 * State tracking:
 *   Each tab and group is assigned a stable sync ID (sId / gSyncId) that
 *   persists across broadcasts. BiMaps (tabSyncIds, groupSyncIds)
 *   translate between Firefox IDs and sync IDs bidirectionally.
 *   Per peer, lastKnownRemoteState stores the most recent remote tab set
 *   so incremental sync can compute diffs.
 *
 * Health:
 *   A periodic health check sends MIRROR_PING to each peer. Peers that
 *   have not sent any data within stalePeerTimeout are closed and
 *   redialed. Sleep/wake transitions trigger a full reconnect.
 */

const TEST_MODE = false;

// Config
const BROADCAST_DEBOUNCE_MS = 300;
const BROADCAST_DEBOUNCE_FAST_MS = 100;
const BROADCAST_AFTER_SYNC_MS = 500;
const DISCOVER_INTERVAL_MS = TEST_MODE ? 5000 : 20000;
const INITIAL_DISCOVERY_INTERVAL_MS = 3000;
const MAX_INITIAL_DISCOVERY_ATTEMPTS = 40;

// Validation limits
const MAX_URL_LENGTH = 8192;
const MAX_TAB_INDEX = 10000;
const MAX_GROUP_TITLE_LENGTH = 256;
const INDEX_MATCH_TOLERANCE = 3;
const MAX_REMOTE_TABS = 500;
const MAX_REMOTE_GROUPS = 100;
const MAX_PEER_ID_LENGTH = 128;
const VALID_GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

// Timing
const AUTH_TIMEOUT_MS = 10000;
const PAIRING_TIMEOUT_MS = 60000;
const PAIRING_JOIN_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 60000;
const STALE_PEER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const RECONNECT_DELAY_MS = 5000;
const MIN_RETRY_BACKOFF_MS = 1000;
const MAX_RETRY_BACKOFF_MS = 60000;
const SLEEP_DETECTION_THRESHOLD_MS = 120000;
const SLEEP_DETECTION_INTERVAL_MS = 30000;
const PEER_LIST_TIMEOUT_MS = 5000;

const PEER_CONFIG = TEST_MODE
    ? { host: 'localhost', port: 9000, path: '/myapp', secure: false }
    : { host: '0.peerjs.com', port: 443, secure: true };


// State
let myDeviceId = '';
let syncCounter = 0;
let isProcessingRemote = false;
let lastRemoteSyncTime = new Map(); // peerId -> timestamp
let syncedPeers = new Set();
// (knownPeers, stalePeerTimeout, lastMessageTime, outgoingMuted -> connectionState)
let broadcastDebounce = null;
let broadcastPending = false;
let broadcastInFlight = false;
let broadcastStats = { attempted: 0, completed: 0, deferred: 0 };
let pendingSyncQueue = [];        // Remote states queued up while we're busy processing
let syncHistory = [];             // Last N sync events for debugging
const MAX_SYNC_HISTORY = 50;
let syncPaused = false;           // User toggle: pauses all sync, saved to storage
let syncContainerTabs = true;     // User toggle: sync container tabs, saved to storage
let syncWindowChanged = false;    // Flagged as true in adoptSyncWindow, we clear it after broadcast
let startTime = Date.now();
let syncWindowId = null;

// Connection state
const connectionState = {
    connections: new Map(),     // peerId -> PeerJS DataConnection
    pendingDials: new Set(),    // Peer IDs currently being dialed
    retries: new Map(),         // peerId -> { attempts, lastAttempt }
    lastMessageTime: new Map(), // peerId -> timestamp
    outgoingMuted: false,       // Test flag: blocks all outgoing data
    stalePeerTimeout: STALE_PEER_TIMEOUT_MS,
    _discoverInterval: null,

    get knownPeers() {
        return Array.from(this.connections.keys());
    },

    // Clears connection for a peer that's closed, timed out, or causing errors.
    cleanup(peerId) {
        this.connections.delete(peerId);
        this.pendingDials.delete(peerId);
        authenticatedPeers.delete(peerId);
        this.lastMessageTime.delete(peerId);
        lastRemoteSyncTime.delete(peerId);
    },

    // Closes all connections and clears transport state.
    closeAll() {
        this.connections.forEach((conn) => {
            try {
                conn.close();
            } catch (e) {
                // conn might already be closed
            }
        });
        this.connections.clear();
        this.pendingDials.clear();
        this.retries.clear();
    },

    stopDiscovery() {
        if (this._discoverInterval) {
            clearInterval(this._discoverInterval);
            this._discoverInterval = null;
        }
    },

    reset() {
        this.closeAll();
        this.lastMessageTime.clear();
        this.stopDiscovery();
    }
};

let localGroupChanges = new Map(); // gSyncId -> timestamp for group conflict resolution

// Last known remote state per peer, used for diff-based sync
let lastKnownRemoteState = new Map(); // peerId -> Map<syncId, tabData>

// Pairing & auth state (production only)
let pairedDevices = [];              // { peerId, sharedKey, name, pairedAt }
let pairingState = null;             // { code, tempPeer, status, error }
let authenticatedPeers = new Set();  // peers that passed auth this session
let forceAuthNextConnection = false; // test-only: force authenticateConnection even in TEST_MODE
let encryptionKeyCache = new Map();  // peerId -> CryptoKey (derived AES-256-GCM)
let previousKeyCache = new Map();    // peerId -> CryptoKey (old key during rotation window)
let keyRotationTimers = new Map();   // peerId -> timeout ID for clearing previousKey
let pendingKeyRotation = new Map();  // peerId -> { newKey, generation }
const KEY_ROTATION_WINDOW_MS = 120000; // 2 minutes
const AUTO_KEY_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Notification state
const notificationState = {
    _notifiedPeers: new Set(),
    _log: [],
    _pendingTimers: new Map(),
    _disconnectDelayMs: 30000,
    _MAX_LOG: 50,

    hasNotified(peerId) { return this._notifiedPeers.has(peerId); },
    markNotified(peerId) { this._notifiedPeers.add(peerId); },
    unmarkNotified(peerId) { this._notifiedPeers.delete(peerId); },
    addLog(entry) {
        this._log.push(entry);
        if (this._log.length > this._MAX_LOG) {
            this._log.shift();
        }
    },
    getLog() { return this._log; },
    getNotifiedPeers() { return Array.from(this._notifiedPeers); },
    scheduleDisconnect(peerId, callback) {
        this.cancelDisconnect(peerId);
        const timerId = setTimeout(() => {
            this._pendingTimers.delete(peerId);
            callback();
        }, this._disconnectDelayMs);
        this._pendingTimers.set(peerId, timerId);
    },
    cancelDisconnect(peerId) {
        const timerId = this._pendingTimers.get(peerId);
        if (timerId != null) {
            clearTimeout(timerId);
            this._pendingTimers.delete(peerId);
        }
    },
    setDisconnectDelay(ms) { this._disconnectDelayMs = ms; },
    reset() {
        this._notifiedPeers.clear();
        this._log = [];
        this._pendingTimers.forEach(t => clearTimeout(t));
        this._pendingTimers.clear();
    }
};

// URL Suppression
// Tracks URLs recently applied by sync so that redirect-induced URL changes on the
// receiver don't bounce back and get caught in a loop. Also records pre-sync URLs
// so that redirect artifacts (revert to original URL) don't propagate back.
const urlSuppression = {
    _recentlySynced: new Map(),   // sId -> { url, at }
    _preSyncUrls: new Map(),      // sId -> { preSyncUrl, appliedUrl, at }
    _suppressionMs: 10000,
    _REVERT_WINDOW_MS: 30000,

    // After tabs.create or tabs.update with URL
    recordSyncedUrl(sId, url) {
        this._recentlySynced.set(sId, { url, at: Date.now() });
    },

    // Before tabs.update changes a URL
    recordPreSyncUrl(sId, preSyncUrl, appliedUrl) {
        this._preSyncUrls.set(sId, { preSyncUrl, appliedUrl, at: Date.now() });
    },

    // tabs.onUpdated: returns { suppressed, reason }
    shouldSuppressBroadcast(sId, url) {
        const now = Date.now();
        const recent = this._recentlySynced.get(sId);
        if (recent) {
            if ((now - recent.at) < this._suppressionMs) {
                return { suppressed: true, reason: 'recent-sync' };
            }
            this._recentlySynced.delete(sId);
        }
        const pre = this._preSyncUrls.get(sId);
        if (pre && (now - pre.at) < this._REVERT_WINDOW_MS) {
            if (normalizeUrl(url) === pre.preSyncUrl) {
                return { suppressed: true, reason: 'pre-sync-revert' };
            }
        } else if (pre) {
            this._preSyncUrls.delete(sId);
        }
        return { suppressed: false };
    },

    // captureLocalState: returns override URL or null
    getCaptureOverride(sId, currentUrl) {
        const pre = this._preSyncUrls.get(sId);
        if (pre && (Date.now() - pre.at) < this._REVERT_WINDOW_MS) {
            if (normalizeUrl(currentUrl) === pre.preSyncUrl) {
                return pre.appliedUrl;
            }
        } else if (pre) {
            this._preSyncUrls.delete(sId);
        }
        return null;
    },

    // webNavigation.onCommitted: clears suppression for user nav
    clearForUserNav(sId, url) {
        const pre = this._preSyncUrls.get(sId);
        if (pre && normalizeUrl(url) === pre.preSyncUrl) {
            this._preSyncUrls.delete(sId);
            return true;
        }
        return false;
    },

    // Test helper
    setSuppressionWindow(ms) { this._suppressionMs = ms; },

    // simulateRestart / fullSystemRefresh
    reset() {
        this._recentlySynced.clear();
        this._preSyncUrls.clear();
    }
};

// Tab/Group sync ID mappings (bidirectional)
let tabSyncIds = new BiMap();    // tabId <-> syncId
let groupSyncIds = new BiMap();  // groupId <-> gSyncId
let offlineTombstones = new Set(); // Keys for tabs deleted while disconnected.

// Clears all group-related state in one call.
function clearGroupState() {
    groupSyncIds.clear();
    lastSeenGroupProps.clear();
    localGroupChanges.clear();
}

// Resets all in-memory state. Used by simulateRestart and fullSystemRefresh.
// opts.includeAuth: also clears auth/encryption state and syncedPeers.
function resetAllState(opts = {}) {
    connectionState.reset();
    urlSuppression.reset();
    notificationState.reset();
    pendingSyncQueue = [];
    tabSyncIds.clear();
    clearGroupState();
    offlineTombstones.clear();
    lastKnownRemoteState.clear();
    lastRemoteSyncTime.clear();
    syncHistory = [];
    broadcastStats = { attempted: 0, completed: 0, deferred: 0 };
    if (opts.includeAuth) {
        syncedPeers.clear();
        authenticatedPeers.clear();
        encryptionKeyCache.clear();
        previousKeyCache.clear();
        keyRotationTimers.forEach(t => clearTimeout(t));
        keyRotationTimers.clear();
        pendingKeyRotation.clear();
        syncCounter = 0;
    }
}

// Logging
let logBuffer = [];
const MAX_LOG_ENTRIES = 5000;
const LOG_STORAGE_KEY = 'test_logs';

function fileLog(message, category = 'INFO') {
    if (!TEST_MODE) {
        return;
    }
    const timestamp = new Date().toISOString().split('T')[1];
    const entry = `[${timestamp}] [${myDeviceId}] [${category}] ${message}`;
    console.log(entry);
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    if (logBuffer.length % 10 === 0) {
        browser.storage.local.set({ [LOG_STORAGE_KEY]: logBuffer.join('\n') }).catch(() => {});
    }
}

// Exposed for testing only.
window.getTestLogs = () => logBuffer.join('\n');
window.clearTestLogs = () => {
    logBuffer = [];
    if (TEST_MODE) {
        browser.storage.local.remove(LOG_STORAGE_KEY).catch(() => {});
    }
};

// Device ID
if (TEST_MODE) {
    // Random hex ID avoids collisions when multiple browsers launch close together
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    myDeviceId = 'test-mirror-' + hex;
    console.log(`[TEST MODE] Using test peer ID: ${myDeviceId}`);
} else {
    // Production ID loaded async in init block from storage.local
    myDeviceId = '';
}
window.myDeviceId = myDeviceId;
console.log(`[BOOT] Tab Mirror (PeerJS WebRTC). ID: ${myDeviceId || '(loading...)'}`);

// Diagnostics
window.diag = async () => {
    console.log('--- Tab Mirror Diagnostics ---');
    console.log('ID:', myDeviceId);
    console.log('Connections:', Array.from(connectionState.connections.keys()));
    console.log('Pending Dials:', Array.from(connectionState.pendingDials));
    console.log('Retry States:', Array.from(connectionState.retries.entries()));
    console.log('P2P Server:', !!(window.peer && !window.peer.disconnected));
    console.log('Tab Map Size:', tabSyncIds.size);
    console.log('Group Map Size:', groupSyncIds.size);
    console.log('Synced Peers:', Array.from(syncedPeers));
    console.log('Sync Counter:', syncCounter);
    console.log('Sync Window:', syncWindowId);
    if (!TEST_MODE) {
        console.log('Paired Devices:', pairedDevices.length);
        pairedDevices.forEach(d => {
            const connected = connectionState.connections.has(d.peerId);
            console.log(`  - ${d.peerId}: ${connected ? 'connected' : 'offline'} (paired ${new Date(d.pairedAt).toISOString()})`);
        });
    }
};

window.checkSync = async () => {
    console.log('--- Paired Devices Check ---');
    console.log('Paired:', pairedDevices);
    console.log('Authenticated:', Array.from(authenticatedPeers));
};

window.forceSync = () => {
    console.log('[FORCESYNC] Purging mappings and re-broadcasting...');
    tabSyncIds.clear();
    clearGroupState();
    broadcastState();
};

window.forceConnect = (remoteId) => {
    console.log(`[MANUAL] Forcing connection to ${remoteId}...`);
    connectionState.retries.delete(remoteId);
    connectionState.pendingDials.delete(remoteId);
    dialPeer(remoteId);
};

// URL Helpers
function isPrivilegedUrl(url) {
    if (!url) {
        return false;
    }
    if (url.startsWith('about:') && url !== 'about:blank' && url !== 'about:newtab' && url !== 'about:home') {
        return true;
    }
    if (url.startsWith('moz-extension:')) {
        return true;
    }
    if (url.startsWith('chrome-extension:')) {
        return true;
    }
    // Don't touch test infrastructure tabs
    if (url.includes('testbridge-init')) {
        return true;
    }
    return false;
}

function isSyncableUrl(url) {
    if (!url) {
        return false;
    }
    if (url === 'about:blank') {
        return true;
    }
    if (url.startsWith('about:')) {
        return false;
    }
    if (url.startsWith('moz-extension:') || url.startsWith('chrome-extension:')) {
        return false;
    }
    if (url.includes('testbridge-init')) {
        return false;
    }
    return true;
}

function normalizeUrl(url) {
    if (url === 'about:newtab' || url === 'about:home') {
        return 'about:blank';
    }
    if (url && url.startsWith('about:reader?url=')) {
        try {
            return decodeURIComponent(url.slice('about:reader?url='.length));
        } catch (e) {
            return url;
        }
    }
    return url;
}

function generateSyncId(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return prefix + hex;
}

function isAllowedUrlScheme(url) {
    if (!url) {
        return false;
    }
    if (url.startsWith('http:') || url.startsWith('https:')) {
        return true;
    }
    if (url === 'about:blank' || url === 'about:newtab' || url === 'about:home') {
        return true;
    }
    return false;
}

function validateTabData(tabData) {
    if (!tabData || !tabData.sId) {
        return false;
    }
    if (!isAllowedUrlScheme(tabData.url)) {
        return false;
    }
    if (tabData.url && tabData.url.length > MAX_URL_LENGTH) {
        return false;
    }
    if (tabData.index !== undefined && (tabData.index < 0 || tabData.index > MAX_TAB_INDEX)) {
        return false;
    }
    // Sanitize containerName: must be a short string or strip it
    if (tabData.containerName !== undefined) {
        if (typeof tabData.containerName !== 'string' || tabData.containerName.length > 200) {
            delete tabData.containerName;
        }
    }
    return true;
}

function validateRemoteState(remoteState) {
    if (typeof remoteState.peerId !== 'string' || remoteState.peerId.length > MAX_PEER_ID_LENGTH) {
        fileLog(`Rejected: invalid peerId`, 'SECURITY');
        return null;
    }

    if (!Array.isArray(remoteState.tabs)) {
        fileLog(`Rejected: tabs is not an array`, 'SECURITY');
        return null;
    }

    let tabs = remoteState.tabs;
    if (tabs.length > MAX_REMOTE_TABS) {
        fileLog(`Truncated ${tabs.length} tabs to ${MAX_REMOTE_TABS}`, 'SECURITY');
        tabs = tabs.slice(0, MAX_REMOTE_TABS);
    }

    const validTabs = tabs.filter(validateTabData);
    if (validTabs.length !== tabs.length) {
        fileLog(`Filtered ${tabs.length - validTabs.length} invalid tabs from ${remoteState.peerId}`, 'SECURITY');
    }

    const seenIds = new Set();
    const dedupedTabs = [];
    for (const tab of validTabs) {
        if (seenIds.has(tab.sId)) {
            fileLog(`Dropped duplicate sync ID: ${tab.sId}`, 'SECURITY');
            continue;
        }
        seenIds.add(tab.sId);
        dedupedTabs.push(tab);
    }

    let groups = remoteState.groups || {};
    if (typeof groups !== 'object' || Array.isArray(groups)) {
        groups = {};
    } else {
        const groupEntries = Object.entries(groups);
        if (groupEntries.length > MAX_REMOTE_GROUPS) {
            fileLog(`Truncated ${groupEntries.length} groups to ${MAX_REMOTE_GROUPS}`, 'SECURITY');
            groups = Object.fromEntries(groupEntries.slice(0, MAX_REMOTE_GROUPS));
        }
        for (const [gId, gData] of Object.entries(groups)) {
            if (!gData || typeof gData !== 'object') {
                delete groups[gId];
                continue;
            }
            if (gData.title && typeof gData.title !== 'string') {
                gData.title = '';
            }
            if (gData.title && gData.title.length > MAX_GROUP_TITLE_LENGTH) {
                gData.title = gData.title.slice(0, MAX_GROUP_TITLE_LENGTH);
            }
            if (gData.color && !VALID_GROUP_COLORS.has(gData.color)) {
                gData.color = 'grey';
            }
        }
    }

    return { ...remoteState, tabs: dedupedTabs, groups };
}

if (typeof module !== 'undefined') {
    module.exports = {
        isPrivilegedUrl, isSyncableUrl, normalizeUrl, isAllowedUrlScheme,
        generateSyncId, validateTabData, validateRemoteState,
        urlSuppression, notificationState, connectionState, resetAllState
    };
}

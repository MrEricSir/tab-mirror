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
 *   persists across broadcasts. Bidirectional maps (TAB_ID_TO_SYNC_ID,
 *   SYNC_ID_TO_TAB_ID, etc.) translate between Firefox IDs and sync IDs.
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
let lastRemoteSyncTime = 0;
let syncedPeers = new Set();
let knownPeers = [];        // Pulled from connections Map for test compatibility
let broadcastDebounce = null;
let broadcastPending = false;
let broadcastInFlight = false;
let broadcastStats = { attempted: 0, completed: 0, deferred: 0 };
let stalePeerTimeout = STALE_PEER_TIMEOUT_MS;
let lastMessageTime = new Map();  // peerId -> timestamp of last received data
let outgoingMuted = false;        // Test flag: blocks all outgoing data for stale simulation
let pendingSyncQueue = [];        // Remote states queued up while we're busy processing
let syncHistory = [];             // Last N sync events for debugging
const MAX_SYNC_HISTORY = 50;
let syncPaused = false;           // User toggle: pauses all sync, saved to storage
let syncWindowChanged = false;    // Flagged as true in adoptSyncWindow, we clear it after broadcast
let startTime = Date.now();
let syncWindowId = null;

// PeerJS transport state
let connections = new Map();  // peerId -> PeerJS DataConnection
let pendingDials = new Set(); // Peer IDs currently being dialed
let discoverInterval = null;
let connectionRetries = new Map(); // peerId -> { attempts, lastAttempt } for backoff
let localGroupChanges = new Map(); // gSyncId -> timestamp for group conflict resolution

// Clears connection for a peer that's closed, timed out, or causing errors.
function cleanupPeerConnection(peerId) {
    connections.delete(peerId);
    pendingDials.delete(peerId);
    authenticatedPeers.delete(peerId);
    lastMessageTime.delete(peerId);
    knownPeers = Array.from(connections.keys());
}

// Last known remote state per peer, used for diff-based sync
let lastKnownRemoteState = new Map(); // peerId -> Map<syncId, tabData>

// Pairing & auth state (production only)
let pairedDevices = [];              // { peerId, sharedKey, name, pairedAt }
let pairingState = null;             // { code, tempPeer, status, error }
let authenticatedPeers = new Set();  // peers that passed auth this session
let forceAuthNextConnection = false; // test-only: force authenticateConnection even in TEST_MODE
let encryptionKeyCache = new Map();  // peerId -> CryptoKey (derived AES-256-GCM)
let notifiedPeers = new Set();       // peers we've already shown a connection notification for
let notificationLog = [];            // notification log for testing
const MAX_NOTIFICATION_LOG = 50;
let pendingDisconnectTimers = new Map(); // peerId -> timeout ID for delayed disconnect notifications
let disconnectNotifyDelayMs = 30000;

// Redirect suppression
// Tracks URLs recently applied by sync so that redirect-induced URL changes on the
// receiver don't bounce back and get caught in a loop. This resolves the case where one
// browser is logged in to a page and the other is not.
let recentlySyncedUrls = new Map();  // syncId -> { url, at }
let redirectSuppressionMs = 10000;    // 10s default

// Bounce detection
// Skip syncing URLs that were recently sent to the same tab.
let syncUrlHistory = new Map();  // syncId -> { urls: string[], lastUpdated: number }
const BOUNCE_DETECTION_WINDOW_MS = 30000;
const BOUNCE_MAX_HISTORY = 5;

// Tab/Group sync ID mappings
let TAB_ID_TO_SYNC_ID = new Map();
let SYNC_ID_TO_TAB_ID = new Map();
let GROUP_ID_TO_SYNC_ID = new Map();
let SYNC_ID_TO_GROUP_ID = new Map();

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
    console.log('Connections:', Array.from(connections.keys()));
    console.log('Pending Dials:', Array.from(pendingDials));
    console.log('Retry States:', Array.from(connectionRetries.entries()));
    console.log('P2P Server:', !!(window.peer && !window.peer.disconnected));
    console.log('Tab Map Size:', TAB_ID_TO_SYNC_ID.size);
    console.log('Group Map Size:', GROUP_ID_TO_SYNC_ID.size);
    console.log('Synced Peers:', Array.from(syncedPeers));
    console.log('Sync Counter:', syncCounter);
    console.log('Sync Window:', syncWindowId);
    if (!TEST_MODE) {
        console.log('Paired Devices:', pairedDevices.length);
        pairedDevices.forEach(d => {
            const connected = connections.has(d.peerId);
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
    TAB_ID_TO_SYNC_ID.clear();
    SYNC_ID_TO_TAB_ID.clear();
    GROUP_ID_TO_SYNC_ID.clear();
    SYNC_ID_TO_GROUP_ID.clear();
    localGroupChanges.clear();
    lastSeenGroupProps.clear();
    broadcastState();
};

window.forceConnect = (remoteId) => {
    console.log(`[MANUAL] Forcing connection to ${remoteId}...`);
    connectionRetries.delete(remoteId);
    pendingDials.delete(remoteId);
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

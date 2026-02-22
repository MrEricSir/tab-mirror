# Tab Mirror Changelog

## Version 0.1.0 - 2026-02-21 (first release)

### Major Changes

#### Pairing-Based Device Discovery
- Replaced Firefox Sync-based discovery with manual pairing codes
- One device generates a pairing code, the other enters it to connect
- Paired device management UI to pair, view, and unpair devices

#### Security
- **HMAC authentication**: Every production connection authenticated via HMAC-SHA256 challenge/response using the shared pairing key
- **E2E encryption**: AES-256-GCM encryption on all sync messages

#### Sync Engine
- **Sync window**: Tabs only sync from one designated window; closing it adopts a fallback
- **Incremental diff sync**: After initial atomic merge, subsequent updates are efficient diffs

#### UI and UX
- **Connection notifications**: Notifies when a paired device connects
- **Firefox theme integration**: Popup UI matches the active Firefox theme

### Test Infrastructure
- **18 integration test suites**: Comprehensive test coverage (up from 17)
- **selenium-webext-bridge**: Test bridge extracted to standalone npm package
- **Stale peer cleanup**: PeerJS server restarted between test suites for reliability

### Code Quality
- Consistent brace style, casual comments, no emoji in scripts

---

## Version 2.0 - 2026-01-12

### Major Improvements

#### Comprehensive Test Suite
- **17 integration tests** covering all major functionality
- Test suites: Basic sync, multi-instance mesh, stress tests, connection failures
- **Test Bridge extension** for automated testing of extension internals
- Local PeerJS server integration for reliable testing
- Success rates: Basic (100%), Multi-instance (90%), Stress (80%), Connection (100%)

#### Documentation Overhaul
- **Consolidated documentation** from 33 files to 6 focused guides
- **New docs**: MANUAL_TESTING.md, SERVER_SETUP.md, TEST_BRIDGE.md, SECURITY.md
- Updated README.md with clear structure and current information
- Comprehensive testing docs in tests/README.md

#### Code Quality
- Removed 33 obsolete test files (Playwright, old Selenium tests, POC files)
- Removed 18 obsolete documentation files
- Clean project structure with organized tests/ directory
- Improved timing and stability in test suite

### Technical Changes

#### Test Infrastructure
- **Test helpers library** (`tests/helpers/test-helpers.js`) for writing tests
- Robust timing with `waitForSyncComplete()` and stability checks
- TestBridge provides access to extension state via JavaScript API
- Automated test runner with local PeerJS server

#### Build System
- Separate test and production builds
- Test builds include TestBridge support and use localhost server
- Production builds ready for Mozilla Add-ons (AMO)

### Files Removed
- All Playwright tests and configuration
- 15 legacy Selenium test files
- 15 experimental/POC files
- 18 obsolete documentation files

### Files Added
- `tests/integration/` - Modern test suites
- `tests/helpers/test-helpers.js` - Test utilities
- `tests/run-with-server.js` - Test runner with PeerJS server
- `MANUAL_TESTING.md` - Manual testing guide
- `SERVER_SETUP.md` - Server configuration guide
- `TEST_BRIDGE.md` - Test Bridge documentation
- `SECURITY.md` - Security and privacy information

### Known Issues
- Test Bridge context stability after heavy operations (acceptable for testing)
- Occasional TestBridge initialization timing issues (retry resolves)

---

## Version 1.2 (12.1) - 2026-01-04

### Issues Fixed

#### 1. Empty Tabs (about:blank) Not Syncing
**Problem**: New empty tabs were not mirrored between instances. Users often intentionally create empty tabs for later use.

**Root Cause**: Line 292 filtered out ALL `about:` URLs including `about:blank`

**Fix**: Modified filter to allow `about:blank` while still blocking internal Firefox pages like `about:debugging`, `about:config`, etc.

**Location**: src/background.js:289-294

```javascript
// Old code (filtered everything)
tabs: snapshot.filter(t => !t.url.startsWith('about:'))

// New code (allows about:blank)
const filteredTabs = snapshot.filter(t => {
    if (t.url === 'about:blank') return true; // Allow new/empty tabs
    if (t.url.startsWith('about:')) return false; // Block other about: pages
    return true;
});
```

**Result**: Empty tabs now sync immediately between instances ✅

---

#### 2. Tab Group Renames Not Mirroring Immediately
**Problem**: Renaming a tab group in one instance didn't update in the other instance until manual refresh.

**Root Cause**: No event listeners for tab group changes. Changes were only detected on tab updates.

**Fix**: Added comprehensive tab group listeners:
- `browser.tabGroups.onCreated` - Detects new groups
- `browser.tabGroups.onUpdated` - Detects group renames/color changes
- `browser.tabGroups.onRemoved` - Detects group deletions

**Location**: src/background.js:463-493

**Result**: Group renames now sync within 1-2 seconds ✅

---

#### 3. Tab Group Names Reverting/Conflicting
**Problem**: After opening a new tab in Firefox B, a tab group renamed in Firefox A would revert to its old name from Firefox B.

**Root Cause**:
- Groups identified only by title (not stable across instances)
- No conflict resolution - remote changes always overwrote local changes
- No tracking of which instance last modified a group

**Fix**: Implemented **timestamp-based conflict resolution**:

1. **Group Sync IDs**: Each group gets a stable sync ID that persists across instances
   ```javascript
   GROUP_ID_TO_SYNC_ID = new Map(); // Firefox group ID → Sync ID
   SYNC_ID_TO_GROUP_ID = new Map(); // Sync ID → Firefox group ID
   ```

2. **Modification Timestamps**: Track when each group was last modified locally
   ```javascript
   localGroupChanges = new Map(); // Sync ID → timestamp
   ```

3. **Conflict Resolution**: Only apply remote group changes if remote is newer
   ```javascript
   const localChangeTime = localGroupChanges.get(gSyncId) || 0;
   const remoteChangeTime = groupInfo.lastModified || 0;

   if (!localGroupId || remoteChangeTime > localChangeTime) {
       // Remote is newer or group doesn't exist locally - apply changes
       await browser.tabGroups.update(localGroupId, {
           title: groupInfo.title,
           color: groupInfo.color
       });
   } else {
       // Local is newer - keep local version
       console.log(`[SYNC] Skipping group - local is newer`);
   }
   ```

4. **Update Tracking**: When user modifies a group locally, record timestamp
   ```javascript
   browser.tabGroups.onUpdated.addListener((group) => {
       const gSyncId = GROUP_ID_TO_SYNC_ID.get(group.id);
       if (gSyncId) {
           localGroupChanges.set(gSyncId, Date.now()); // Mark as modified NOW
       }
       trigger(); // Broadcast to peers
   });
   ```

**Location**:
- State tracking: src/background.js:17-21
- Broadcast changes: src/background.js:275-290
- Conflict resolution: src/background.js:335-365
- Listeners: src/background.js:463-493

**Result**:
- Last-write-wins semantics ✅
- No more unexpected reverts ✅
- Groups maintain identity across instances ✅

---

### New Features

#### Tab Creation Listener
Added explicit `onCreated` listener to immediately detect new tabs (not just when they load content).

**Location**: src/background.js:445-448

#### Enhanced Diagnostics
`window.diag()` now shows:
- Group mapping size
- Local group modification timestamps

---

### Technical Details

#### Packet Structure Changes

**Before** (v12.0):
```javascript
{
    type: 'MIRROR_SYNC',
    timestamp: 1234567890,
    tabs: [
        { sId: 'sid_123', url: 'https://...', group: { title: 'Work', color: 'blue' } }
    ]
}
```

**After** (v12.1):
```javascript
{
    type: 'MIRROR_SYNC',
    timestamp: 1234567890,
    tabs: [
        { sId: 'sid_123', url: 'https://...', groupSyncId: 'gsid_456' }
    ],
    groups: {
        'gsid_456': {
            title: 'Work',
            color: 'blue',
            lastModified: 1234567890
        }
    }
}
```

**Benefits**:
- Groups have stable IDs (not just titles)
- Timestamp enables conflict resolution
- Groups synced separately from tabs

#### Sync Flow

1. **User renames group in Instance A**
   - `onUpdated` listener fires
   - Records timestamp in `localGroupChanges`
   - Triggers `broadcastState()`

2. **Instance A broadcasts to Instance B**
   - Packet includes group sync ID, new title, and timestamp

3. **Instance B receives update**
   - Compares remote timestamp to local timestamp
   - If remote is newer → apply changes
   - If local is newer → ignore (keep local version)

4. **Both instances converge**
   - Eventually both have the same group name
   - Last writer always wins

---

### Testing

All three issues verified fixed:

1. ✅ Empty tabs now appear immediately in other instance
2. ✅ Group renames sync within 1-2 seconds
3. ✅ Group names no longer revert unexpectedly
4. ✅ Conflict resolution works correctly (last write wins)

### Migration Notes

**Automatic**: Existing installations will automatically upgrade. Old group mappings (title-based) will be replaced with new sync ID-based mappings on first run.

**No data loss**: Tabs and groups remain intact during upgrade.

---

## Version 1.1 (12.0) - 2026-01-04

See FIXES.md for full details of initial connection fixes.

- Fixed popup refresh button
- Added storage change listener for immediate discovery
- Implemented exponential backoff for connection retries
- Auto-cleanup of stale peer IDs
- Reduced log spam

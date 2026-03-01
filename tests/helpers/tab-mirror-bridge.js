/**
 * TabMirrorBridge - Tab Mirror-specific subclass of TestBridge
 */

const { TestBridge } = require('selenium-webext-bridge');
const { sleep } = require('selenium-webext-bridge');

const TAB_MIRROR_ID = 'tab-mirror@test.local';

class TabMirrorBridge extends TestBridge {
  constructor(driver) {
    super(driver);
    this.targetId = TAB_MIRROR_ID;
  }

  /**
   * Send a message to Tab Mirror and unwrap the response.
   * Tab Mirror wraps responses in { success, data } so we just extract .data here.
   */
  async _sendToTabMirror(payload) {
    const response = await this.sendToExtension(this.targetId, payload);
    if (response && response.success) {
      return response.data;
    } else if (response && response.error) {
      throw new Error(response.error);
    }
    return response;
  }

  /**
   * Get Tab Mirror extension state
   */
  async getState() {
    await this.ensureReady();
    try {
      return await this._sendToTabMirror({ action: 'getState' });
    } catch (error) {
      // Recover if we hit fatal errors or TestBridge goes away
      if (error.name === 'NoSuchWindowError' ||
          (error.message && (error.message.includes('Browsing context has been discarded') ||
           error.message.includes('Document was unloaded') ||
           error.message.includes('TestBridge is undefined')))) {
        // Context got nuked (tab closed/unloaded) or TestBridge not available, reinitialize
        console.log('[TabMirrorBridge] Context lost, reinitializing...');
        await sleep(3000);
        this.ready = false;
        await this.init();
        return await this._sendToTabMirror({ action: 'getState' });
      }
      throw error;
    }
  }

  /**
   * Get console logs from Tab Mirror
   */
  async getLogs() {
    return await this._sendToTabMirror({ action: 'getLogs' });
  }

  /**
   * Trigger a sync in Tab Mirror
   */
  async triggerSync() {
    return await this._sendToTabMirror({ action: 'triggerSync' });
  }

  /**
   * Get device ID
   */
  async getDeviceId() {
    const state = await this.getState();
    return state.myDeviceId;
  }

  /**
   * Get number of connected peers
   */
  async getConnectionCount() {
    const state = await this.getState();
    return state.connections.length;
  }

  /**
   * Get synced peers
   */
  async getSyncedPeers() {
    const state = await this.getState();
    return state.syncedPeers;
  }

  /**
   * Get sync window ID
   */
  async getSyncWindowId() {
    const state = await this.getState();
    return state.syncWindowId;
  }

  /**
   * Inject arbitrary remote state for testing validation (test-only)
   */
  async injectRemoteState(remoteState) {
    return await this._sendToTabMirror({ action: 'injectRemoteState', remoteState });
  }

  async getBroadcastStats() {
    return await this._sendToTabMirror({ action: 'getBroadcastStats' });
  }

  async resetBroadcastStats() {
    return await this._sendToTabMirror({ action: 'resetBroadcastStats' });
  }

  async createStaleMapping(syncId, tabId) {
    return await this._sendToTabMirror({ action: 'createStaleMapping', syncId, tabId });
  }

  async createPrivateWindow(url) {
    return await this._sendToTabMirror({ action: 'createPrivateWindow', url });
  }

  async setStalePeerTimeout(timeout) {
    return await this._sendToTabMirror({ action: 'setStalePeerTimeout', timeout });
  }

  async setDisconnectNotifyDelay(delay) {
    return await this._sendToTabMirror({ action: 'setDisconnectNotifyDelay', delay });
  }

  async pauseDiscovery() {
    return await this._sendToTabMirror({ action: 'pauseDiscovery' });
  }

  async resumeDiscovery() {
    return await this._sendToTabMirror({ action: 'resumeDiscovery' });
  }

  async setRedirectSuppressionWindow(ms) {
    return await this._sendToTabMirror({ action: 'setRedirectSuppressionWindow', ms });
  }

  async muteOutgoing(muted) {
    return await this._sendToTabMirror({ action: 'muteOutgoing', muted });
  }

  async runHealthCheck() {
    return await this._sendToTabMirror({ action: 'runHealthCheck' });
  }

  async disconnectPeer(peerId) {
    return await this._sendToTabMirror({ action: 'disconnectPeer', peerId });
  }

  async testEncryption() {
    return await this._sendToTabMirror({ action: 'testEncryption' });
  }

  async testSyncQueue() {
    return await this._sendToTabMirror({ action: 'testSyncQueue' });
  }

  async getLastMessageTimes() {
    return await this._sendToTabMirror({ action: 'getLastMessageTimes' });
  }

  /**
   * Simulate a restart (wipes in-memory state, keeps syncedPeers, reconnects)
   */
  async simulateRestart() {
    return await this._sendToTabMirror({ action: 'simulateRestart' });
  }

  /**
   * Force replaceLocalState with current state to test idempotency.
   * Returns { tabsBefore, tabsAfter, groupsBefore, groupsAfter }.
   */
  async forceReplaceLocalState() {
    return await this._sendToTabMirror({ action: 'forceReplaceLocalState' });
  }

  /**
   * Get current group count and details.
   * Returns { groups, groupedTabs, groupDetails }.
   */
  async getGroupCount() {
    return await this._sendToTabMirror({ action: 'getGroupCount' });
  }

  /**
   * Add a paired device
   */
  async addPairedDevice(peerId, name) {
    return await this._sendToTabMirror({ action: 'addPairedDevice', peerId, name });
  }

  /**
   * Get paired devices list
   */
  async getPairedDevices() {
    return await this._sendToTabMirror({ action: 'getPairedDevices' });
  }

  /**
   * Unpair a device
   */
  async unpairDevice(peerId) {
    return await this._sendToTabMirror({ action: 'unpairDevice', peerId });
  }

  /**
   * Switch the sync window to a different window ID (test-only)
   */
  async adoptSyncWindow(windowId) {
    return await this._sendToTabMirror({ action: 'adoptSyncWindow', windowId });
  }

  /**
   * Get notification log (notifications fired this session)
   */
  async getNotificationLog() {
    return await this._sendToTabMirror({ action: 'getNotificationLog' });
  }

  /**
   * Get the moz-extension:// base URL for Tab Mirror.
   * Heads up: navigates away from the bridge page (auto-recovers on next call).
   */
  async getPopupUrl() {
    const base = await this.getExtensionUrl(TAB_MIRROR_ID);
    return base ? `${base}/popup.html` : null;
  }

  /**
   * Wait until we have the expected number of connections
   */
  async waitForConnections(expectedCount, timeout = 10000) {
    const startTime = Date.now();
    let lastCount = -1;

    while (Date.now() - startTime < timeout) {
      try {
        const connectionCount = await this.getConnectionCount();

        if (connectionCount !== lastCount) {
          console.log(`  [waitForConnections] Current: ${connectionCount}, Expected: ${expectedCount}`);
          lastCount = connectionCount;
        }

        if (connectionCount === expectedCount) {
          // Give it a moment to make sure the connection is stable
          await sleep(500);
          // Double-check it's still the same
          const verifyCount = await this.getConnectionCount();
          if (verifyCount === expectedCount) {
            return true;
          }
        }
        await sleep(500);
      } catch (error) {
        // Context might've been lost, keep trying
        console.log(`  [waitForConnections] Temporary error: ${error.message}`);
        await sleep(500);
      }
    }

    return false;
  }

  /**
   * Wait for sync to settle (no recent sync activity)
   */
  async waitForSyncComplete(timeout = 10000) {
    const startTime = Date.now();
    let lastSyncCounter = -1;
    let stableCount = 0;

    console.log('  [waitForSyncComplete] Waiting for sync to complete...');

    while (Date.now() - startTime < timeout) {
      try {
        const state = await this.getState();

        if (state.syncCounter === lastSyncCounter) {
          stableCount++;
          if (stableCount >= 3) {
            // Counter stable for 3 checks, sync probably done
            console.log(`  [waitForSyncComplete] Sync appears complete (counter stable at ${state.syncCounter})`);
            return true;
          }
        } else {
          console.log(`  [waitForSyncComplete] Sync counter: ${state.syncCounter}`);
          lastSyncCounter = state.syncCounter;
          stableCount = 0;
        }

        await sleep(300);
      } catch (error) {
        console.log(`  [waitForSyncComplete] Temporary error: ${error.message}`);
        await sleep(300);
      }
    }

    console.log('  [waitForSyncComplete] Timed out waiting for sync');
    return false;
  }

  /**
   * Wait for a group with a given title to exist (or not exist).
   * @param {string} title - Group title to look for
   * @param {boolean} shouldExist - true = wait for it to appear, false = wait for it to vanish
   * @param {number} timeout - Max wait in ms (default 15000)
   * @returns Group details if found, true when gone, null/false on timeout
   */
  async waitForGroupState(title, shouldExist, timeout = 15000) {
    const startTime = Date.now();
    console.log(`  [waitForGroupState] Waiting for group "${title}" to ${shouldExist ? 'appear' : 'disappear'}...`);

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.getGroupCount();
        const group = result.groupDetails.find(g => g.title === title);

        if (shouldExist && group) {
          console.log(`  [waitForGroupState] Found group "${title}" (${group.tabCount} tabs, ${group.color})`);
          return group;
        }

        if (!shouldExist && !group) {
          console.log(`  [waitForGroupState] Group "${title}" is gone`);
          return true;
        }

        await sleep(250);
      } catch (error) {
        console.log(`  [waitForGroupState] Temporary error: ${error.message}`);
        await sleep(250);
      }
    }

    console.log(`  [waitForGroupState] Timeout waiting for group "${title}" to ${shouldExist ? 'appear' : 'disappear'}`);
    return shouldExist ? null : false;
  }
}

module.exports = { TabMirrorBridge };

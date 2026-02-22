/**
 * Tab Mirror Popup - Device Pairing UI
 */

let pairingPollInterval = null;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function updateUI() {
    try {
        const response = await browser.runtime.sendMessage({ action: "getStatus" }).catch(() => {
            return { online: false, peers: 0, id: "Connecting...", pairedCount: 0 };
        });

        if (!response) {
            return;
        }

        if (response.id) {
            document.getElementById('deviceName').textContent = friendlyName(response.id);
        }

        const hasPaired = response.pairedCount > 0;
        const dot = document.getElementById('statusDot');

        if (response.syncPaused) {
            dot.style.color = "var(--accent)";
        } else if (response.peers > 0) {
            dot.style.color = "var(--status-green)";
        } else if (response.online) {
            dot.style.color = "var(--status-yellow)";
        } else {
            dot.style.color = "var(--status-red)";
        }

        // Show/hide sections relevant to paired devices
        document.getElementById('pairedDevicesSection').style.display = hasPaired ? 'block' : 'none';
        document.getElementById('actionButtons').style.display = hasPaired ? 'block' : 'none';

        // Update sync toggle, skip if user is interacting
        const syncToggle = document.getElementById('syncToggle');
        if (syncToggle && document.activeElement !== syncToggle) {
            syncToggle.checked = !response.syncPaused;
        }

        // Update debug info
        updateDebugInfo();

        // Update paired devices list
        if (hasPaired) {
            await updatePairedDevices();
        }
    } catch (e) {
        console.error("Popup UI Error:", e);
    }
}

// Generate a friendly two-word name from a peer ID (fallback for raw IDs)
const ADJECTIVES = [
    'Red','Blue','Green','Gold','Silver','Amber','Coral','Jade','Teal','Plum',
    'Sage','Rust','Slate','Pearl','Maple','Cedar','Dusk','Dawn','Mint','Opal',
    'Warm','Bold','Pale','Dark','Soft','Neon','Icy','Hazy','Wild','Calm',
    'Keen','Rare','True','Pure','Vivid','Swift','Stark','Noble','Grand','Lucid',
    'Brisk','Crisp','Dusky','Ashen','Sandy','Rosy','Misty','Ivory','Smoky','Sunny'
];
const ANIMALS = [
    'Fox','Owl','Bear','Wolf','Hawk','Lynx','Deer','Seal','Wren','Dove',
    'Hare','Orca','Swan','Crow','Moth','Newt','Crab','Frog','Wasp','Mole',
    'Pike','Lark','Ibis','Yak','Ram','Jay','Elk','Koi','Tern','Vole',
    'Puma','Shrew','Finch','Gecko','Stork','Crane','Egret','Skunk','Bison','Otter',
    'Raven','Quail','Heron','Trout','Perch','Snipe','Dingo','Lemur','Macaw','Koala'
];

function friendlyName(peerId) {
    // Simple hash from peer ID string
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
        hash = ((hash << 5) - hash + peerId.charCodeAt(i)) | 0;
    }
    hash = Math.abs(hash);
    return ADJECTIVES[hash % ADJECTIVES.length] + ' ' + ANIMALS[Math.floor(hash / ADJECTIVES.length) % ANIMALS.length];
}

function shortPlatform(name) {
    const match = name && name.match(/on (.+)$/);
    return match ? match[1] : '';
}

function displayName(device) {
    const petName = friendlyName(device.peerId);
    const platform = shortPlatform(device.name);
    return platform ? `${petName} · ${platform}` : petName;
}

async function updatePairedDevices() {
    try {
        const container = document.getElementById('pairedDevicesList');

        // Skip re-render while an unpair confirm is showing
        if (container.querySelector('.unpair-confirm')) {
            return;
        }

        const response = await browser.runtime.sendMessage({ action: "getPairedDevices" });

        if (!response || !response.devices || response.devices.length === 0) {
            container.innerHTML = '<div class="no-devices">' + escapeHtml(browser.i18n.getMessage('placeholderNoDevices')) + '</div>';
            return;
        }

        container.innerHTML = response.devices.map(device => `
            <div class="paired-device">
                <div class="device-info">
                    <span class="device-status ${device.connected ? 'connected' : 'offline'}">${device.connected ? '●' : '○'}</span>
                    <span class="device-name" title="${escapeHtml(device.peerId)}">${escapeHtml(displayName(device))}</span>
                </div>
                <button class="unpair-btn" data-peer-id="${escapeHtml(device.peerId)}">${escapeHtml(browser.i18n.getMessage('buttonUnpair'))}</button>
            </div>
        `).join('');

        // Attach unpair handlers
        container.querySelectorAll('.unpair-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const peerId = btn.dataset.peerId;
                // Replace button with inline confirm/cancel
                const confirmDiv = document.createElement('div');
                confirmDiv.className = 'unpair-confirm';
                confirmDiv.innerHTML = `
                    <button class="confirm-yes">${escapeHtml(browser.i18n.getMessage('buttonUnpair'))}</button>
                    <button class="confirm-no">${escapeHtml(browser.i18n.getMessage('buttonCancel'))}</button>
                `;
                btn.replaceWith(confirmDiv);
                confirmDiv.querySelector('.confirm-yes').addEventListener('click', async () => {
                    await browser.runtime.sendMessage({ action: "unpairDevice", peerId });
                    confirmDiv.remove();
                    await updatePairedDevices();
                });
                confirmDiv.querySelector('.confirm-no').addEventListener('click', () => {
                    updatePairedDevices();
                });
            });
        });
    } catch (e) {
        console.error("Paired devices error:", e);
    }
}

async function updateDebugInfo() {
    try {
        const debugInfo = await browser.runtime.sendMessage({ action: "getDebugInfo" });

        if (debugInfo) {
            document.getElementById('debugInfo').textContent = formatDebugInfo(debugInfo);
            document.getElementById('syncHistory').textContent = formatSyncHistory(debugInfo.syncHistory);
        }
    } catch (e) {
        console.error("Debug Info Error:", e);
    }
}

function formatSyncHistory(history) {
    if (!history || history.length === 0) {
        return browser.i18n.getMessage('placeholderNoSyncEvents');
    }

    // Show newest first
    return history.slice().reverse().map(e => {
        const t = new Date(e.time).toLocaleTimeString();
        const name = friendlyName(e.peer);
        const parts = [];
        if (e.added > 0) {
            parts.push(`+${e.added}`);
        }
        if (e.removed > 0) {
            parts.push(`-${e.removed}`);
        }
        if (e.updated > 0) {
            parts.push(`~${e.updated}`);
        }
        const changes = parts.length > 0 ? parts.join(' ') : browser.i18n.getMessage('syncNoChanges');
        return `${t}  ${name}  ${changes}  (${e.type})`;
    }).join('\n');
}

function formatDebugInfo(info) {
    let text = `Device ID: ${info.id}
Online: ${info.online}
Active Peers: ${info.peers}
Known Peers: ${info.connectedPeers?.join(', ') || 'none'}
Synced Peers: ${info.syncedPeers?.join(', ') || 'none'}

Tab Mappings: ${info.tabMappings || 0}
Group Mappings: ${info.groupMappings || 0}
Processing Remote: ${info.isProcessingRemote || false}
Last Sync: ${info.lastSyncTime || 'never'}
Sync Counter: ${info.syncCounter || 0}

Transport: ${info.transport || 'unknown'}
Version: ${info.version || 'sync-prototype'}
Uptime: ${info.uptime || '0s'}`;

    if (info.pairedDevices) {
        text += `\n\nPaired Devices: ${info.pairedDevices.length}`;
        for (const d of info.pairedDevices) {
            text += `\n  - ${d.peerId} (${d.name})`;
        }
    }
    if (info.authenticatedPeers) {
        text += `\nAuthenticated: ${info.authenticatedPeers.join(', ') || 'none'}`;
    }

    return text;
}

// Pairing UI

function showPairMode() {
    const pairingUI = document.getElementById('pairingUI');
    const pairButtons = document.getElementById('pairButtons');

    pairButtons.style.display = 'none';
    pairingUI.style.display = 'block';
    pairingUI.innerHTML = `
        <div class="pairing-ui">
            <div class="pairing-status">${escapeHtml(browser.i18n.getMessage('pairingGeneratingCode'))}</div>
        </div>
    `;

    browser.runtime.sendMessage({ action: "startPairing" }).then(response => {
        if (response && response.success) {
            pairingUI.innerHTML = `
                <div class="pairing-ui">
                    <div class="pairing-status">${escapeHtml(browser.i18n.getMessage('pairingEnterCodeOnOther'))}</div>
                    <div class="pairing-code-row">
                        <div class="pairing-code">${escapeHtml(response.code)}</div>
                        <button class="copy-code-btn" id="copyCodeBtn" title="Copy code">&#x2398;</button>
                    </div>
                    <div class="pairing-status" id="pairStatusText">${escapeHtml(browser.i18n.getMessage('pairingWaitingForConnection'))}</div>
                    <button class="cancel-btn" id="cancelPairBtn">${escapeHtml(browser.i18n.getMessage('buttonCancel'))}</button>
                </div>
            `;
            document.getElementById('cancelPairBtn').addEventListener('click', cancelPairingUI);
            document.getElementById('copyCodeBtn').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(response.code);
                    const btn = document.getElementById('copyCodeBtn');
                    btn.classList.add('copied');
                    btn.innerHTML = '&#x2713;';
                    setTimeout(() => {
                        btn.classList.remove('copied');
                        btn.innerHTML = '&#x2398;';
                    }, 1500);
                } catch (e) {
                    // clipboard may fail
                }
            });
            startPairingPoll();
        } else {
            pairingUI.innerHTML = `
                <div class="pairing-ui">
                    <div class="pairing-status">${escapeHtml(browser.i18n.getMessage('pairingFailedToStart'))}</div>
                    <button class="cancel-btn" id="cancelPairBtn">${escapeHtml(browser.i18n.getMessage('buttonBack'))}</button>
                </div>
            `;
            document.getElementById('cancelPairBtn').addEventListener('click', cancelPairingUI);
        }
    });
}

function showJoinMode() {
    const pairingUI = document.getElementById('pairingUI');
    const pairButtons = document.getElementById('pairButtons');

    pairButtons.style.display = 'none';
    pairingUI.style.display = 'block';
    pairingUI.innerHTML = `
        <div class="pairing-ui">
            <div class="pairing-status">${escapeHtml(browser.i18n.getMessage('pairingEnterCodeFromOther'))}</div>
            <div class="pairing-input">
                <input type="text" id="joinCodeInput" maxlength="9" placeholder="XXXX-XXXX" autocapitalize="characters" spellcheck="false" />
                <button id="joinConnectBtn">${escapeHtml(browser.i18n.getMessage('buttonConnect'))}</button>
            </div>
            <div class="pairing-status" id="joinStatusText"></div>
            <button class="cancel-btn" id="cancelJoinBtn">${escapeHtml(browser.i18n.getMessage('buttonCancel'))}</button>
        </div>
    `;

    const input = document.getElementById('joinCodeInput');
    input.focus();

    // Allow only valid pairing charset + dash, auto-uppercase
    input.addEventListener('input', () => {
        let val = input.value.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ\-]/g, '');
        // Auto-insert dash after 4 chars if user is typing naturally
        const raw = val.replace(/-/g, '');
        if (raw.length > 4 && !val.includes('-')) {
            val = raw.slice(0, 4) + '-' + raw.slice(4);
        }
        input.value = val;
    });

    document.getElementById('joinConnectBtn').addEventListener('click', submitJoinCode);
    document.getElementById('cancelJoinBtn').addEventListener('click', cancelPairingUI);

    // Enter key submits
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            submitJoinCode();
        }
    });
}

async function submitJoinCode() {
    const input = document.getElementById('joinCodeInput');
    const statusText = document.getElementById('joinStatusText');
    const code = input.value.trim().replace(/[-\s]/g, '').toUpperCase();

    if (code.length !== 8) {
        statusText.textContent = browser.i18n.getMessage('pairingEnterFullCode');
        return;
    }

    statusText.textContent = browser.i18n.getMessage('pairingConnecting');
    const btn = document.getElementById('joinConnectBtn');
    btn.disabled = true;

    const response = await browser.runtime.sendMessage({ action: "joinPairing", code });

    if (response && response.success) {
        startPairingPoll();
    } else {
        statusText.textContent = response?.error || browser.i18n.getMessage('pairingFailed');
        btn.disabled = false;
    }
}

function startPairingPoll() {
    stopPairingPoll();
    pairingPollInterval = setInterval(async () => {
        const status = await browser.runtime.sendMessage({ action: "getPairingStatus" });
        if (!status) {
            return;
        }

        const statusText = document.getElementById('pairStatusText') || document.getElementById('joinStatusText');
        if (!statusText) {
            return;
        }

        switch (status.status) {
            case 'success':
                statusText.textContent = browser.i18n.getMessage('pairingSuccess');
                statusText.style.color = 'var(--status-green)';
                stopPairingPoll();
                setTimeout(() => {
                    cancelPairingUI();
                    updatePairedDevices();
                }, 1500);
                break;
            case 'exchanging':
                statusText.textContent = browser.i18n.getMessage('pairingExchangingKeys');
                break;
            case 'timeout':
                statusText.textContent = browser.i18n.getMessage('pairingTimedOut');
                statusText.style.color = 'var(--status-red)';
                stopPairingPoll();
                break;
            case 'error':
                statusText.textContent = status.error || browser.i18n.getMessage('pairingFailed');
                statusText.style.color = 'var(--status-red)';
                stopPairingPoll();
                break;
            case 'none':
                // Pairing was cancelled or completed
                stopPairingPoll();
                break;
        }
    }, 1000);
}

function stopPairingPoll() {
    if (pairingPollInterval) {
        clearInterval(pairingPollInterval);
        pairingPollInterval = null;
    }
}

function cancelPairingUI() {
    stopPairingPoll();
    browser.runtime.sendMessage({ action: "cancelPairing" }).catch(() => {});
    document.getElementById('pairingUI').style.display = 'none';
    document.getElementById('pairButtons').style.display = 'flex';
}

// Event Listeners

document.getElementById('pairBtn').addEventListener('click', showPairMode);
document.getElementById('joinBtn').addEventListener('click', showJoinMode);

document.getElementById('syncNowBtn').addEventListener('click', async () => {
    const btn = document.getElementById('syncNowBtn');
    btn.textContent = browser.i18n.getMessage('buttonSyncing');
    btn.disabled = true;
    await browser.runtime.sendMessage({ action: "triggerSync" });
    setTimeout(() => {
        btn.textContent = browser.i18n.getMessage('buttonSyncNow');
        btn.disabled = false;
    }, 1000);
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.textContent = browser.i18n.getMessage('buttonRefreshing');
    await browser.runtime.sendMessage({ action: "fullSystemRefresh" });
    setTimeout(() => {
        btn.textContent = browser.i18n.getMessage('buttonResetConnection');
        updateUI();
    }, 1000);
});

document.getElementById('syncToggle').addEventListener('change', async (e) => {
    await browser.runtime.sendMessage({ action: "setSyncPaused", paused: !e.target.checked });
    updateUI();
});

// Debug toggle
function toggleDebug() {
    const content = document.getElementById('debugContent');
    const toggle = document.getElementById('debugToggle');
    const arrow = toggle.querySelector('.toggle-arrow');

    if (content.style.display === 'none') {
        content.style.display = 'block';
        arrow.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        updateDebugInfo();
    } else {
        content.style.display = 'none';
        arrow.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    }
}
document.getElementById('debugToggle').addEventListener('click', toggleDebug);
document.getElementById('debugToggle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDebug();
    }
});

// Copy debug info
document.getElementById('copyDebugBtn').addEventListener('click', async () => {
    const debugInfo = await browser.runtime.sendMessage({ action: "getDebugInfo" });
    const text = formatDebugInfo(debugInfo);

    try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('copyDebugBtn');
        const originalText = btn.textContent;
        btn.textContent = browser.i18n.getMessage('buttonCopied');
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (e) {
        console.error("Failed to copy:", e);
    }
});

// Test logs section (only shown in TEST_MODE)
async function updateTestLogs() {
    try {
        const response = await browser.runtime.sendMessage({ type: 'GET_TEST_LOGS' });
        const logsDiv = document.getElementById('testLogs');
        const section = document.getElementById('testLogsSection');

        if (response && response.logs && response.logs.length > 0) {
            section.style.display = 'block';
            logsDiv.textContent = response.logs;
        } else {
            logsDiv.textContent = browser.i18n.getMessage('placeholderNoLogs');
        }
    } catch (e) {
        console.log("Test logs not available (not in TEST_MODE)");
    }
}

// Test logs toggle
function toggleTestLogs() {
    const content = document.getElementById('testLogsContent');
    const toggle = document.getElementById('testLogsToggle');
    const arrow = toggle.querySelector('.toggle-arrow');

    if (content.style.display === 'none') {
        content.style.display = 'block';
        arrow.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        updateTestLogs();
    } else {
        content.style.display = 'none';
        arrow.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    }
}
document.getElementById('testLogsToggle').addEventListener('click', toggleTestLogs);
document.getElementById('testLogsToggle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleTestLogs();
    }
});

// Copy test logs
document.getElementById('copyLogsBtn').addEventListener('click', async () => {
    const logs = document.getElementById('testLogs').textContent;

    try {
        await navigator.clipboard.writeText(logs);
        const btn = document.getElementById('copyLogsBtn');
        const originalText = btn.textContent;
        btn.textContent = browser.i18n.getMessage('buttonCopied');
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (e) {
        console.error("Failed to copy logs:", e);
    }
});

// Check for test logs on startup
updateTestLogs();

// i18n: replace __MSG_*__ placeholders in static HTML
const msgRe = /__MSG_(\w+)__/g;
const replacer = (_, key) => browser.i18n.getMessage(key) || _;
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) {
    const node = walker.currentNode;
    if (msgRe.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(msgRe, replacer);
    }
}
document.querySelectorAll('[aria-label*="__MSG_"]').forEach(el => {
    el.setAttribute('aria-label', el.getAttribute('aria-label').replace(msgRe, replacer));
});

// Firefox Theme Integration
// Override CSS custom properties with the active Firefox theme colors.
// Falls back to prefers-color-scheme defaults when theme colors
// aren't available (e.g. default Firefox theme).

function applyThemeColors(theme) {
    const c = theme?.colors;
    if (!c) {
        return;
    }

    const root = document.documentElement;
    let applied = false;

    function set(prop, value) {
        if (value) {
            root.style.setProperty(prop, value);
            applied = true;
        }
    }

    // Core popup colors
    set('--bg', c.popup);
    set('--text', c.popup_text);
    set('--border', c.popup_border);

    // Accent from popup highlight
    set('--accent', c.popup_highlight);
    set('--accent-text', c.popup_highlight_text);

    // Secondary backgrounds (debug panels, log areas) --
    // shift popup bg slightly toward text color for subtle contrast
    if (c.popup && c.popup_text) {
        set('--log-bg', `color-mix(in srgb, ${c.popup} 85%, ${c.popup_text})`);
    }

    // Muted text: blend popup_text toward bg for softer contrast
    if (c.popup_text && c.popup) {
        set('--muted', `color-mix(in srgb, ${c.popup_text} 60%, ${c.popup})`);
    }

    // Mark as themed so CSS can skip media-query fallbacks
    if (applied) {
        root.setAttribute('data-themed', '');
    }
}

browser.theme.getCurrent().then(applyThemeColors);
browser.theme.onUpdated.addListener(({ theme }) => applyThemeColors(theme));

setInterval(updateUI, 1000);
updateUI();

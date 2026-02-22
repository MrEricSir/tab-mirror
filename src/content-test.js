// Test-only content script for log retrieval
// This script runs on all pages in TEST_MODE to allow Selenium to retrieve logs

console.log('[TAB MIRROR TEST] Content script loaded');

// Content scripts run in an isolated world with their own window object.
// To expose functions to the page (where Selenium can call them), we inject
// a script that talks to the content script via custom events.

// Listen for requests from the injected page script
window.addEventListener('TAB_MIRROR_GET_LOGS_REQUEST', async () => {
    console.log('[TAB MIRROR TEST] Received log request from page');
    console.log('[TAB MIRROR TEST] browser available?', typeof browser !== 'undefined');
    console.log('[TAB MIRROR TEST] browser.runtime available?', typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined');

    // Store result to send back
    let resultLogs = '';

    try {
        console.log('[TAB MIRROR TEST] Calling browser.runtime.sendMessage...');
        const response = await browser.runtime.sendMessage({ type: 'GET_TEST_LOGS' });
        console.log('[TAB MIRROR TEST] Got response:', response ? 'YES' : 'NO');
        console.log('[TAB MIRROR TEST] Response logs?', response && response.logs ? 'YES' : 'NO');

        resultLogs = response.logs || 'No logs in response';
    } catch (e) {
        console.error('[TAB MIRROR TEST] Error getting logs:', e);
        resultLogs = 'Error: ' + e.toString();
    }

    console.log('[TAB MIRROR TEST] Dispatching response event with', resultLogs.length, 'chars');

    // Send response back to page via custom event
    window.dispatchEvent(new CustomEvent('TAB_MIRROR_GET_LOGS_RESPONSE', {
        detail: { logs: resultLogs }
    }));

    console.log('[TAB MIRROR TEST] Response event dispatched');
});

// Inject a script into the page context to expose window.getTabMirrorLogs
const script = document.createElement('script');
script.textContent = `
    console.log('[TAB MIRROR TEST PAGE] Injected script loaded');

    // This runs in the page context, so it has access to the real window object
    window.getTabMirrorLogs = function() {
        return new Promise((resolve) => {
            console.log('[TAB MIRROR TEST PAGE] getTabMirrorLogs called');

            // Listen for response from content script
            const listener = (event) => {
                console.log('[TAB MIRROR TEST PAGE] Received response');
                window.removeEventListener('TAB_MIRROR_GET_LOGS_RESPONSE', listener);
                resolve(event.detail.logs);
            };
            window.addEventListener('TAB_MIRROR_GET_LOGS_RESPONSE', listener);

            // Request logs from content script
            window.dispatchEvent(new Event('TAB_MIRROR_GET_LOGS_REQUEST'));
        });
    };

    console.log('[TAB MIRROR TEST PAGE] window.getTabMirrorLogs exposed');
`;
document.documentElement.appendChild(script);
script.remove();

// Mark that content script loaded
document.documentElement.setAttribute('data-tab-mirror-test', 'loaded');
console.log('[TAB MIRROR TEST] Content script setup complete');

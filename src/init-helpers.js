// init-helpers.js
// Pure helper functions extracted from init.js for testability.

/**
 * Returns true if we have received at least one message from this peer
 * (lastMessageAt > 0) and the elapsed time since that message exceeds the
 * given timeout.
 */
function isConnectionStale(lastMessageAt, now, timeout) {
    return lastMessageAt > 0 && (now - lastMessageAt) > timeout;
}

/**
 * Returns true if the gap between `now` and `lastTickTime` exceeds the
 * threshold, indicating the machine likely slept and has just woken up.
 */
function didWakeFromSleep(now, lastTickTime, threshold) {
    return (now - lastTickTime) > threshold;
}

if (typeof module !== 'undefined') {
    module.exports = { isConnectionStale, didWakeFromSleep };
}

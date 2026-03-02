// Crypto Utilities
// Used for pairing & authentication

async function generateSharedKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes));
}

async function computeHMAC(base64Key, message) {
    const keyBytes = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyHMAC(base64Key, message, hexSignature) {
    const expected = await computeHMAC(base64Key, message);
    return expected === hexSignature;
}

// E2E Encryption (AES-256-GCM)

async function deriveEncryptionKey(base64SharedKey) {
    const keyBytes = Uint8Array.from(atob(base64SharedKey), c => c.charCodeAt(0));
    const baseKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HKDF' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode('tab-mirror-e2e-v1'),
            info: new TextEncoder().encode('aes-256-gcm-sync-encryption')
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptState(cryptoKey, stateObject) {
    const plaintext = new TextEncoder().encode(JSON.stringify(stateObject));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
    return {
        type: 'MIRROR_SYNC_ENCRYPTED',
        peerId: stateObject.peerId,
        iv: btoa(String.fromCharCode(...iv)),
        ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
    };
}

async function decryptState(cryptoKey, encryptedMessage) {
    try {
        const iv = Uint8Array.from(atob(encryptedMessage.iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(encryptedMessage.ciphertext), c => c.charCodeAt(0));
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (e) {
        console.warn('[CRYPTO] Decryption failed:', e.message);
        fileLog(`Decryption failed for ${encryptedMessage.peerId}: ${e.message}`, 'SECURITY');
        return null;
    }
}

async function getOrDeriveEncryptionKey(peerId) {
    if (encryptionKeyCache.has(peerId)) {
        return encryptionKeyCache.get(peerId);
    }
    const sharedKey = getSharedKeyForPeer(peerId);
    if (!sharedKey) {
        return null;
    }
    const cryptoKey = await deriveEncryptionKey(sharedKey);
    encryptionKeyCache.set(peerId, cryptoKey);
    return cryptoKey;
}

// Unambiguous charset (no 0/O, 1/I/l confusables) -- 32 chars, 8 chars = ~40 bits entropy
const PAIRING_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generatePairingCode() {
    const arr = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(arr).map(b => PAIRING_CHARSET[b % PAIRING_CHARSET.length]).join('');
}

function formatPairingCode(code) {
    return code.slice(0, 4) + '-' + code.slice(4);
}

function normalizePairingCode(input) {
    return input.replace(/[-\s]/g, '').toUpperCase();
}

async function getDeviceName() {
    try {
        const info = await browser.runtime.getPlatformInfo();
        const osNames = { mac: 'macOS', win: 'Windows', linux: 'Linux', android: 'Android', cros: 'ChromeOS', openbsd: 'OpenBSD' };
        const os = osNames[info.os] || info.os;
        return `Firefox on ${os}`;
    } catch (e) {
        return 'Firefox';
    }
}

if (typeof module !== 'undefined') {
    module.exports = { formatPairingCode, normalizePairingCode };
}

// Serialises client-ID minting across an extension's worker and pages (#51).
// No Angular imports: seedNgGa4ClientId() uses it at worker top level.

import { LOCK_TIMEOUT_MS, withLock } from './web-lock';

export const CLIENT_ID_LOCK_NAME = 'ng-ga4:client-id';

// Bounds the wait so a stuck holder can't block init() (an APP_INITIALIZER).
export const CLIENT_ID_LOCK_TIMEOUT_MS = LOCK_TIMEOUT_MS;

/**
 * Runs `critical` under the client-ID lock. Runs it unlocked if Web Locks are
 * unavailable, refused, or not granted within `timeoutMs`. Errors from
 * `critical` are rethrown, never retried.
 */
export function withClientIdLock<T>(
    critical: () => Promise<T>,
    timeoutMs: number = CLIENT_ID_LOCK_TIMEOUT_MS
): Promise<T> {
    return withLock(CLIENT_ID_LOCK_NAME, critical, { timeoutMs, label: 'client-ID' });
}

async function readStoredClientId(): Promise<string | null> {
    const existing = (await chrome.storage.local.get(['ga_client_id']))['ga_client_id'];
    return typeof existing === 'string' && existing ? existing : null;
}

/**
 * Returns the client ID in `chrome.storage.local`, minting one under the lock
 * if there is none. `persist` saves a new ID; it must resolve once the write
 * has landed, since the lock is released when it does. Throws on storage
 * failure.
 */
export async function readOrMintChromeClientId(persist: (clientId: string) => Promise<void>): Promise<string> {
    // Unlocked fast path: once an ID exists, nobody mints again.
    const stored = await readStoredClientId();
    if (stored) {
        return stored;
    }
    return withClientIdLock(async () => {
        const existing = await readStoredClientId();
        if (existing) {
            return existing;
        }
        // A UUID, not mintGtagClientId(): there is no _ga cookie on a
        // chrome-extension:// origin to match.
        const clientId = crypto.randomUUID();
        await persist(clientId);
        return clientId;
    });
}

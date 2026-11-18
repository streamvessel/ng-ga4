// Serialises client-ID minting across an extension's worker and pages (#51).
// No Angular imports: seedNgGa4ClientId() uses it at worker top level.

export const CLIENT_ID_LOCK_NAME = 'ng-ga4:client-id';

// Bounds the wait so a stuck holder can't block init() (an APP_INITIALIZER).
export const CLIENT_ID_LOCK_TIMEOUT_MS = 3000;

function lockManager(): LockManager | null {
    if (typeof navigator === 'undefined') {
        return null;
    }
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Runs `critical` under the client-ID lock. Runs it unlocked if Web Locks are
 * unavailable, refused, or not granted within `timeoutMs`. Errors from
 * `critical` are rethrown, never retried.
 */
export async function withClientIdLock<T>(
    critical: () => Promise<T>,
    timeoutMs: number = CLIENT_ID_LOCK_TIMEOUT_MS
): Promise<T> {
    const locks = lockManager();
    if (!locks) {
        return critical();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let settle: () => T;
    try {
        // The callback must not reject: under zone.js that surfaces as an
        // unhandled rejection even though it is caught here.
        settle = await locks.request(CLIENT_ID_LOCK_NAME, { signal: controller.signal }, () =>
            critical().then(
                (value): (() => T) => () => value,
                (error): (() => T) => () => { throw error; }
            )
        );
    } catch (err) {
        // Not granted: timed out or refused.
        console.warn('[ng-ga4] Could not acquire the client-ID lock; continuing without it.', err);
        return critical();
    } finally {
        clearTimeout(timer);
    }
    return settle();
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
        const clientId = crypto.randomUUID();
        await persist(clientId);
        return clientId;
    });
}

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
 * Runs `critical` under the client-ID lock. `critical` must do the whole
 * read-check-write. Runs unlocked if Web Locks are unavailable, refused, or not
 * granted within `timeoutMs`. Errors from `critical` are rethrown, never retried.
 */
export async function withClientIdLock<T>(
    critical: () => Promise<T>,
    timeoutMs: number = CLIENT_ID_LOCK_TIMEOUT_MS
): Promise<T> {
    const locks = lockManager();
    if (!locks || typeof AbortController === 'undefined') {
        return critical();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The callback must not reject: under zone.js that surfaces as an unhandled
    // rejection even though it is caught here.
    let failed = false;
    let value: T;
    let error: unknown;
    try {
        await locks.request(CLIENT_ID_LOCK_NAME, { signal: controller.signal }, async () => {
            clearTimeout(timer);
            try {
                value = await critical();
            } catch (err) {
                failed = true;
                error = err;
            }
        });
    } catch (err) {
        // Not granted: timed out or refused.
        console.warn('[ng-ga4] Could not acquire the client-ID lock; continuing without it.', err);
        return critical();
    } finally {
        clearTimeout(timer);
    }
    if (failed) {
        throw error;
    }
    return value;
}

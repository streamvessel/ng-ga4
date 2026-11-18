// A Web Lock shared by every context of one origin — an MV3 service worker and
// the extension's popup, options page or side panel all share
// `chrome-extension://<id>`, and a site's tabs share its origin. Fails open.
// No Angular imports: seedNgGa4ClientId() uses it at worker top level.

// Bounds the wait so a stuck holder can't block init() (an APP_INITIALIZER)
// or a storage chain everything else queues behind.
export const LOCK_TIMEOUT_MS = 3000;

function lockManager(): LockManager | null {
    if (typeof navigator === 'undefined') {
        return null;
    }
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Runs `critical` under the lock called `name`. Runs it unlocked if Web Locks
 * are unavailable, refused, or not granted within `timeoutMs`. Errors from
 * `critical` are rethrown, never retried. `label` names the lock in the
 * warning logged when it is not granted.
 */
export async function withLock<T>(
    name: string,
    critical: () => Promise<T>,
    { timeoutMs = LOCK_TIMEOUT_MS, label = name }: { timeoutMs?: number; label?: string } = {}
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
        settle = await locks.request(name, { signal: controller.signal }, () =>
            critical().then(
                (value): (() => T) => () => value,
                (error): (() => T) => () => { throw error; }
            )
        );
    } catch (err) {
        // Not granted: timed out or refused.
        console.warn(`[ng-ga4] Could not acquire the ${label} lock; continuing without it.`, err);
        return critical();
    } finally {
        clearTimeout(timer);
    }
    return settle();
}

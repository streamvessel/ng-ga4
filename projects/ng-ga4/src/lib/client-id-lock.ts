/**
 * Serialises the client ID's get-miss-mint-set sequence across every context of
 * one origin — an MV3 service worker and the extension's popup, options page or
 * side panel all share `chrome-extension://<id>` — so two contexts starting cold
 * together cannot both miss and both mint (issue #51).
 *
 * Deliberately standalone — no Angular imports — because seedNgGa4ClientId()
 * takes the same lock at service-worker top level, before any injector exists.
 */

/**
 * The Web Locks name. Shared by seedNgGa4ClientId() and the service's own
 * extension mint path, so a seed in the worker and a service booting in a popup
 * serialise against each other as well as against themselves.
 */
export const CLIENT_ID_LOCK_NAME = 'ng-ga4:client-id';

/**
 * How long to wait for the lock before giving up and running unlocked.
 *
 * init() is an APP_INITIALIZER, so a lock that is never released (a holder
 * whose chrome.storage call hangs) would otherwise stop the extension booting.
 * The section held is one storage read and at most one write, normally a few
 * milliseconds, so this only matters when something is already broken — and
 * then failing open to the pre-lock behaviour is the right trade: the worst
 * case is the duplicate identity this lock exists to prevent, not a hang.
 */
export const CLIENT_ID_LOCK_TIMEOUT_MS = 3000;

/**
 * `navigator.locks`, or null where Web Locks are unavailable: server rendering,
 * browsers that predate the API, and non-secure contexts (the API is
 * `[SecureContext]`; `chrome-extension://` is secure). Read on every call rather
 * than cached, so a test can swap it.
 */
function lockManager(): LockManager | null {
    if (typeof navigator === 'undefined') {
        return null;
    }
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Run `critical` holding the exclusive client-ID lock, or unlocked where that
 * is not possible.
 *
 * `critical` must do the whole read-check-write itself — re-reading storage
 * *inside* the lock is what makes the second context see the first one's ID.
 *
 * Fails open: if Web Locks are missing, the request is refused (an opaque
 * origin throws SecurityError), or the lock is not granted within
 * `timeoutMs`, `critical` runs without it, which is exactly the behaviour
 * before the lock existed. An error thrown by `critical` itself is rethrown
 * untouched and never triggers a second, unlocked run — that would mint twice.
 */
export async function withClientIdLock<T>(
    critical: () => Promise<T>,
    timeoutMs: number = CLIENT_ID_LOCK_TIMEOUT_MS
): Promise<T> {
    const locks = lockManager();
    if (!locks || typeof AbortController === 'undefined') {
        return critical();
    }

    // The signal only bounds the *wait*: per the Web Locks spec, aborting after
    // the lock has been granted has no effect, so a slow holder is never cut off
    // mid-write. The timer is cleared on grant anyway, to keep it from firing
    // into an unrelated later moment.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The callback settles the outcome itself and never rejects. Handing the
    // native LockManager a rejected promise works, but under zone.js it is a
    // ZoneAwarePromise the browser adopts a tick later, so zone reports it as an
    // unhandled rejection even though we catch it — a spurious console error
    // every time chrome.storage fails inside the lock.
    let ran = false;
    let failed = false;
    let value: T;
    let error: unknown;
    try {
        await locks.request(CLIENT_ID_LOCK_NAME, { signal: controller.signal }, async () => {
            clearTimeout(timer);
            ran = true;
            try {
                value = await critical();
            } catch (err) {
                failed = true;
                error = err;
            }
        });
    } catch (err) {
        // Only reachable without a grant — aborted by the timeout, or refused.
        console.warn('[ng-ga4] Could not acquire the client-ID lock; continuing without it.', err);
        return critical();
    } finally {
        clearTimeout(timer);
    }
    if (!ran) {
        // Unreachable with a conforming LockManager: request() resolves only
        // after the callback has run.
        return critical();
    }
    if (failed) {
        throw error;
    }
    return value;
}

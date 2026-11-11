/**
 * Test double for `navigator.locks`. Specs only — nothing in the public API
 * imports it, so it never reaches the published bundle.
 *
 * Exclusive, FIFO per name, like the real LockManager, but grants on a
 * microtask. A real grant arrives on a task, which a spec that drains only
 * microtasks under jasmine.clock() can never reach.
 */
export class FakeLockManager {
    /** Lock names requested, in request order. */
    readonly requested: string[] = [];
    /** Callbacks currently running under a lock, across all names. */
    held = 0;
    /** The most callbacks ever running under one name at once. 1 means serialised. */
    maxHeld = 0;

    private readonly tails = new Map<string, Promise<void>>();

    request<T>(
        name: string,
        optionsOrCallback: { signal?: AbortSignal } | ((lock: unknown) => Promise<T> | T),
        maybeCallback?: (lock: unknown) => Promise<T> | T
    ): Promise<T> {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        const signal = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback.signal;
        this.requested.push(name);

        const previous = this.tails.get(name) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>(resolve => { release = resolve; });
        this.tails.set(name, previous.then(() => mine));

        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) {
                release();
                reject(new DOMException('The lock request was aborted.', 'AbortError'));
                return;
            }
            let granted = false;
            // Aborting after the grant has no effect, per the Web Locks spec.
            signal?.addEventListener('abort', () => {
                if (granted) {
                    return;
                }
                reject(new DOMException('The lock request was aborted.', 'AbortError'));
            });
            previous.then(async () => {
                // Aborted while queued: never granted, matching the spec.
                if (signal?.aborted) {
                    release();
                    return;
                }
                granted = true;
                this.held++;
                this.maxHeld = Math.max(this.maxHeld, this.held);
                try {
                    resolve(await callback({ name, mode: 'exclusive' }));
                } catch (err) {
                    reject(err);
                } finally {
                    this.held--;
                    release();
                }
            });
        });
    }
}

/**
 * Replace `navigator.locks` for the current spec. `undefined` simulates a
 * browser without Web Locks. Returns the restore function.
 *
 * Shadowed with an own property rather than reassigned: the real one is a
 * getter on Navigator.prototype, so deleting the own property restores it.
 */
export function installLockManager(locks: unknown): () => void {
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    return () => { delete (navigator as unknown as { locks?: unknown }).locks; };
}

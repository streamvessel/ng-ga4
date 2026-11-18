// Test double for navigator.locks: exclusive and FIFO per name like the real
// one, but grants on a microtask so specs that only drain microtasks under
// jasmine.clock() still progress.
export class FakeLockManager {
    readonly requested: string[] = [];
    held = 0;
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
            const aborted = () => new DOMException('The lock request was aborted.', 'AbortError');
            if (signal?.aborted) {
                release();
                reject(aborted());
                return;
            }
            let granted = false;
            signal?.addEventListener('abort', () => {
                if (!granted) {
                    reject(aborted());
                }
            });
            previous.then(async () => {
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

// Shadows navigator.locks for one spec; `undefined` simulates no Web Locks.
// Returns a restore function.
export function installLockManager(locks: unknown): () => void {
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    return () => { delete (navigator as unknown as { locks?: unknown }).locks; };
}

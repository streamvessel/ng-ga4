// Test double for navigator.locks: exclusive and FIFO like the real one, but
// grants on a microtask so specs that only drain microtasks under
// jasmine.clock() still progress. Only one lock name is ever used.
export class FakeLockManager {
    readonly requested: string[] = [];
    maxHeld = 0;

    private held = 0;
    private tail: Promise<void> = Promise.resolve();

    request<T>(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<T> | T): Promise<T> {
        this.requested.push(name);
        const previous = this.tail;
        let release!: () => void;
        this.tail = previous.then(() => new Promise<void>(resolve => { release = resolve; }));

        return new Promise<T>((resolve, reject) => {
            let granted = false;
            options.signal?.addEventListener('abort', () => {
                if (!granted) {
                    reject(new DOMException('The lock request was aborted.', 'AbortError'));
                }
            }, { once: true });
            previous.then(async () => {
                if (options.signal?.aborted) {
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

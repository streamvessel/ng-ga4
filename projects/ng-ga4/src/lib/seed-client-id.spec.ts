import { seedNgGa4ClientId } from './seed-client-id';
import { CLIENT_ID_LOCK_NAME } from './client-id-lock';
import { FakeLockManager, installLockManager } from './testing/fake-lock-manager';

describe('seedNgGa4ClientId', () => {
    let originalChrome: any;
    let hadChrome: boolean;

    beforeEach(() => {
        // The whole object is saved and replaced with a shallow copy, not just
        // `.storage` stashed: one spec below deletes `window.chrome` outright, so
        // restoring only `.storage` would throw on undefined. Copying also keeps
        // our `.storage` mutations off the object ng-ga4.service.spec.ts shares.
        hadChrome = 'chrome' in (window as any);
        originalChrome = (window as any).chrome;
        (window as any).chrome = { ...originalChrome };
    });

    afterEach(() => {
        if (hadChrome) {
            (window as any).chrome = originalChrome;
        } else {
            delete (window as any).chrome;
        }
    });

    function mockChrome(store: Record<string, any>, overrides: any = {}): void {
        (window as any).chrome.storage = {
            local: {
                get: (keys: string[]) => Promise.resolve(
                    keys.reduce((acc: any, k: string) => { if (store[k] !== undefined) acc[k] = store[k]; return acc; }, {})
                ),
                set: (items: any) => { Object.assign(store, items); return Promise.resolve(); },
                ...overrides
            }
        };
    }

    it('mints and persists a client ID when none is stored', async () => {
        const store: Record<string, any> = {};
        mockChrome(store);

        const result = await seedNgGa4ClientId();

        expect(typeof result).toBe('string');
        expect(result!.length).toBeGreaterThan(0);
        expect(store['ga_client_id']).toBe(result!);
    });

    it('returns the stored client ID without overwriting it', async () => {
        const store: Record<string, any> = { ga_client_id: 'already-here' };
        const setSpy = jasmine.createSpy('set').and.returnValue(Promise.resolve());
        mockChrome(store, { set: setSpy });

        const result = await seedNgGa4ClientId();

        expect(result).toBe('already-here');
        expect(setSpy).not.toHaveBeenCalled();
    });

    it('ignores a non-string stored value and mints instead', async () => {
        const store: Record<string, any> = { ga_client_id: 42 };
        mockChrome(store);

        const result = await seedNgGa4ClientId();

        expect(typeof result).toBe('string');
        expect(store['ga_client_id']).toBe(result!);
    });

    it('returns null and warns when chrome.storage is unavailable', async () => {
        delete (window as any).chrome.storage;
        spyOn(console, 'warn');

        expect(await seedNgGa4ClientId()).toBeNull();
        // The specific message, not just "warned": the catch-all below also
        // returns null and warns, so a looser assertion would pass even with the
        // availability guard deleted entirely.
        expect(console.warn).toHaveBeenCalledWith(
            jasmine.stringContaining('chrome.storage.local is unavailable')
        );
    });

    // The genuinely-undeclared case (Firefox, Safari, SSR) cannot be reached from
    // here: `window.chrome` is a non-configurable property in Chrome, so it cannot
    // be deleted, and assigning `undefined` satisfies the same `typeof` check the
    // real case would. That path is instead safe by construction — the availability
    // check lives inside seedNgGa4ClientId's try/catch, so a ReferenceError returns
    // null rather than escaping. This spec covers the nearest reachable shape.
    it('returns null rather than throwing when chrome is not an object', async () => {
        (window as any).chrome = null;
        spyOn(console, 'warn');

        await expectAsync(seedNgGa4ClientId()).toBeResolvedTo(null);
        expect(console.warn).toHaveBeenCalledWith(
            jasmine.stringContaining('chrome.storage.local is unavailable')
        );
    });

    it('treats an empty stored client ID as absent and mints instead', async () => {
        const store: Record<string, any> = { ga_client_id: '' };
        mockChrome(store);

        const result = await seedNgGa4ClientId();

        expect(result).not.toBe('');
        expect(store['ga_client_id']).toBe(result!);
    });

    it('returns null and warns when the read rejects', async () => {
        mockChrome({}, { get: () => Promise.reject(new Error('no access')) });
        spyOn(console, 'warn');

        expect(await seedNgGa4ClientId()).toBeNull();
        expect(console.warn).toHaveBeenCalled();
    });

    it('returns null and warns when the write rejects', async () => {
        mockChrome({}, { set: () => Promise.reject(new Error('quota exceeded')) });
        spyOn(console, 'warn');

        expect(await seedNgGa4ClientId()).toBeNull();
        expect(console.warn).toHaveBeenCalled();
    });

    // Concurrent cold start (#51): a worker's seed and a popup booting at the
    // same moment. Storage here is asynchronous on a real task, as
    // chrome.storage is, so both callers' reads can land before either write.
    describe('concurrent cold start', () => {
        let restoreLocks: (() => void) | undefined;

        afterEach(() => {
            restoreLocks?.();
            restoreLocks = undefined;
        });

        function mockSlowChrome(store: Record<string, any>, setSpy: jasmine.Spy): void {
            const later = <T>(fn: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(fn()), 1));
            mockChrome(store, {
                get: (keys: string[]) => later(() =>
                    keys.reduce((acc: any, k: string) => { if (store[k] !== undefined) acc[k] = store[k]; return acc; }, {})
                ),
                set: (items: any) => { setSpy(items); return later(() => { Object.assign(store, items); }); }
            });
        }

        it('both callers end up with one ID, written once, under the real navigator.locks', async () => {
            const store: Record<string, any> = {};
            const setSpy = jasmine.createSpy('set');
            mockSlowChrome(store, setSpy);

            const [a, b] = await Promise.all([seedNgGa4ClientId(), seedNgGa4ClientId()]);

            expect(a).toBeTruthy();
            expect(b).toBe(a);
            expect(store['ga_client_id']).toBe(a!);
            expect(setSpy).toHaveBeenCalledTimes(1);
        });

        it('requests the shared client-ID lock', async () => {
            const locks = new FakeLockManager();
            restoreLocks = installLockManager(locks);
            mockSlowChrome({}, jasmine.createSpy('set'));

            await Promise.all([seedNgGa4ClientId(), seedNgGa4ClientId()]);

            expect(locks.requested).toEqual([CLIENT_ID_LOCK_NAME, CLIENT_ID_LOCK_NAME]);
            expect(locks.maxHeld).toBe(1);
        });

        // The control arm: without Web Locks the fallback is the pre-#51
        // behaviour, and this mock reproduces the race the lock closes. If this
        // ever starts passing with one ID, the spec above has stopped proving
        // anything.
        it('still works, but can mint twice, where navigator.locks is unavailable', async () => {
            restoreLocks = installLockManager(undefined);
            const store: Record<string, any> = {};
            const setSpy = jasmine.createSpy('set');
            mockSlowChrome(store, setSpy);

            const [a, b] = await Promise.all([seedNgGa4ClientId(), seedNgGa4ClientId()]);

            expect(a).toBeTruthy();
            expect(b).toBeTruthy();
            expect(b).not.toBe(a);
            expect(setSpy).toHaveBeenCalledTimes(2);
        });
    });
});

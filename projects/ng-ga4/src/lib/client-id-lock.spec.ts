import { CLIENT_ID_LOCK_NAME, withClientIdLock } from './client-id-lock';
import { FakeLockManager, installLockManager } from './testing/fake-lock-manager';

describe('withClientIdLock', () => {
    let restoreLocks: (() => void) | undefined;

    afterEach(() => {
        restoreLocks?.();
        restoreLocks = undefined;
    });

    function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>(r => { resolve = r; });
        return { promise, resolve };
    }

    it('runs the critical section under the shared client-ID lock name', async () => {
        const locks = new FakeLockManager();
        restoreLocks = installLockManager(locks);

        expect(await withClientIdLock(async () => 'id')).toBe('id');
        expect(locks.requested).toEqual([CLIENT_ID_LOCK_NAME]);
        expect(CLIENT_ID_LOCK_NAME).toBe('ng-ga4:client-id');
    });

    it('does not let a second caller in until the first has finished', async () => {
        const locks = new FakeLockManager();
        restoreLocks = installLockManager(locks);
        const gate = deferred();
        const order: string[] = [];

        const first = withClientIdLock(async () => { order.push('a:start'); await gate.promise; order.push('a:end'); });
        const second = withClientIdLock(async () => { order.push('b:start'); });

        for (let i = 0; i < 10; i++) { await Promise.resolve(); }
        expect(order).toEqual(['a:start']);

        gate.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start']);
        expect(locks.maxHeld).toBe(1);
    });

    it('runs unlocked where navigator.locks is unavailable', async () => {
        restoreLocks = installLockManager(undefined);
        const critical = jasmine.createSpy('critical').and.resolveTo('id');

        expect(await withClientIdLock(critical)).toBe('id');
        expect(critical).toHaveBeenCalledTimes(1);
    });

    it('fails open, with a warning, when the request itself is refused', async () => {
        // An opaque origin rejects every request with SecurityError.
        restoreLocks = installLockManager({
            request: () => Promise.reject(new DOMException('opaque origin', 'SecurityError'))
        });
        spyOn(console, 'warn');
        const critical = jasmine.createSpy('critical').and.resolveTo('id');

        expect(await withClientIdLock(critical)).toBe('id');
        expect(critical).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith(jasmine.stringContaining('client-ID lock'), jasmine.anything());
    });

    it('fails open after the timeout rather than waiting forever on a stuck holder', async () => {
        const locks = new FakeLockManager();
        restoreLocks = installLockManager(locks);
        spyOn(console, 'warn');
        const stuck = deferred();
        // A holder that never releases: init() is an APP_INITIALIZER, so waiting
        // on this unboundedly would stop the extension booting.
        const holder = locks.request(CLIENT_ID_LOCK_NAME, () => stuck.promise);

        const critical = jasmine.createSpy('critical').and.resolveTo('id');
        expect(await withClientIdLock(critical, 20)).toBe('id');
        expect(critical).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalled();

        stuck.resolve();
        await holder;
        // The aborted request must not run critical a second time once the
        // holder finally lets go.
        for (let i = 0; i < 10; i++) { await Promise.resolve(); }
        expect(critical).toHaveBeenCalledTimes(1);
    });

    it('rethrows an error from the critical section without a second, unlocked run', async () => {
        restoreLocks = installLockManager(new FakeLockManager());
        spyOn(console, 'warn');
        const critical = jasmine.createSpy('critical').and.rejectWith(new Error('storage failed'));

        await expectAsync(withClientIdLock(critical)).toBeRejectedWithError('storage failed');
        // Running it again unlocked would be a second mint — the bug, not a fallback.
        expect(critical).toHaveBeenCalledTimes(1);
        expect(console.warn).not.toHaveBeenCalled();
    });

    // Against the browser's own LockManager rather than the fake: Karma's Chrome
    // implements Web Locks, so this checks the request shape we send is one the
    // real API accepts and serialises. Same page, one agent — it says nothing
    // about cross-context sharing, which is what the PR's extension run measures.
    it('serialises against the real navigator.locks', async () => {
        expect(navigator.locks).toBeDefined();
        let inside = 0;
        let maxInside = 0;
        const critical = async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await new Promise(resolve => setTimeout(resolve, 5));
            inside--;
        };

        await Promise.all([withClientIdLock(critical), withClientIdLock(critical), withClientIdLock(critical)]);
        expect(maxInside).toBe(1);
    });
});

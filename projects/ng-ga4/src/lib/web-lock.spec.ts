import { withLock } from './web-lock';
import { FakeLockManager, installLockManager } from './testing/fake-lock-manager';

describe('withLock', () => {
    let restore: () => void;

    afterEach(() => restore());

    it('requests the lock by the name it is given', async () => {
        const locks = new FakeLockManager();
        restore = installLockManager(locks);

        expect(await withLock('ng-ga4:outbox', async () => 'done')).toBe('done');
        expect(locks.requested).toEqual(['ng-ga4:outbox']);
    });

    it('names the lock it could not get in the warning', async () => {
        restore = installLockManager({ request: () => Promise.reject(new DOMException('no', 'SecurityError')) });
        const warn = spyOn(console, 'warn');

        expect(await withLock('ng-ga4:outbox', async () => 'unlocked', { label: 'outbox' })).toBe('unlocked');
        expect(warn).toHaveBeenCalledWith(jasmine.stringContaining('the outbox lock'), jasmine.anything());
    });
});

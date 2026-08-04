import { ConsentState } from './consent';

describe('ConsentState', () => {
    it('allows storage by default', () => {
        expect(new ConsentState().storageAllowed).toBe(true);
    });

    it('omits the payload entirely when no ad signal is set', () => {
        expect(new ConsentState().toPayload()).toBeNull();
    });

    it('denies storage when the initial state says so', () => {
        expect(new ConsentState({ analyticsStorage: 'denied' }).storageAllowed).toBe(false);
    });
});

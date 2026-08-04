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

    it('merges partially, leaving unspecified keys alone', () => {
        const consent = new ConsentState({ adUserData: 'granted' });
        consent.merge({ adPersonalization: 'denied' });
        expect(consent.toPayload()).toEqual({ ad_user_data: 'GRANTED', ad_personalization: 'DENIED' });
    });

    it('ignores keys explicitly set to undefined rather than wiping them', () => {
        const consent = new ConsentState({ adUserData: 'granted' });
        consent.merge({ adUserData: undefined });
        expect(consent.toPayload()).toEqual({ ad_user_data: 'GRANTED' });
    });

    it('fails closed on an invalid analyticsStorage value', () => {
        const warn = spyOn(console, 'warn');
        const consent = new ConsentState();
        consent.merge({ analyticsStorage: 'Denied' as any });
        expect(consent.storageAllowed).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('fails closed on an invalid ad signal rather than omitting it', () => {
        spyOn(console, 'warn');
        const consent = new ConsentState();
        consent.merge({ adUserData: 'yes' as any });
        // Omitting would let GA4 apply the property default, which may be granted.
        expect(consent.toPayload()).toEqual({ ad_user_data: 'DENIED' });
    });

    it('fails closed on an invalid value supplied via the constructor', () => {
        spyOn(console, 'warn');
        expect(new ConsentState({ analyticsStorage: 'GRANTED' as any }).storageAllowed).toBe(false);
    });
});

// Consent state for the Measurement Protocol.
//
// Note the asymmetry, which the whole design turns on: `adUserData` and
// `adPersonalization` are *declarative* — we put them in the request body and GA4
// acts on them. `analyticsStorage` is never sent anywhere; it governs whether
// *we* are allowed to persist identifiers locally. gtag.js treats all three as
// one concept because it owns both sides; we only own one.
//
// Pure by design — no browser globals — so the merge and projection rules can be
// tested without a TestBed.

export type NgGa4ConsentState = 'granted' | 'denied';

export interface NgGa4Consent {
    /** → payload `consent.ad_user_data`. Unset means the key is omitted. */
    adUserData?: NgGa4ConsentState;
    /** → payload `consent.ad_personalization`. Unset means the key is omitted. */
    adPersonalization?: NgGa4ConsentState;
    /**
     * Never sent. Gates local persistence of identifiers (`localStorage`,
     * `chrome.storage`, the `_ga` cookie). Defaults to `'granted'`.
     */
    analyticsStorage?: NgGa4ConsentState;
}

/** The MP payload projection. `analytics_storage` is deliberately absent — it is not an MP field. */
export interface Ga4ConsentPayload {
    ad_user_data?: 'GRANTED' | 'DENIED';
    ad_personalization?: 'GRANTED' | 'DENIED';
}

export class ConsentState {
    private state: NgGa4Consent = {};

    constructor(initial?: NgGa4Consent) {
        if (initial) {
            this.merge(initial);
        }
    }

    /**
     * Storage is allowed unless explicitly denied. Absent means granted — see the
     * "default granted" decision in the spec: defaulting to denied would silently
     * stop collection for every existing install on upgrade.
     */
    get storageAllowed(): boolean {
        return this.state.analyticsStorage !== 'denied';
    }

    merge(partial: NgGa4Consent): void {
        for (const key of ['adUserData', 'adPersonalization', 'analyticsStorage'] as const) {
            if (!(key in partial)) {
                continue;
            }
            const value = partial[key];
            // An explicit `undefined` is a no-op, not a reset: callers spreading a
            // partial object should not silently clear a previously granted signal.
            if (value === undefined) {
                continue;
            }
            if (value === 'granted' || value === 'denied') {
                this.state[key] = value;
                continue;
            }
            // Fail closed, for all three. storageAllowed treats anything but
            // 'denied' as permission, and an omitted ad signal lets GA4 fall back
            // to a property default that may be granted — so neither "ignore" nor
            // "leave unset" is safe. TypeScript blocks this path; untyped callers
            // and values threaded from a consent tool do not.
            console.warn(`[ng-ga4] Invalid consent value "${value}" for "${key}" — treating as denied.`);
            this.state[key] = 'denied';
        }
    }

    /** `null` when neither ad signal is set, so the key is omitted from the body entirely. */
    toPayload(): Ga4ConsentPayload | null {
        const payload: Ga4ConsentPayload = {};
        if (this.state.adUserData) {
            payload.ad_user_data = this.state.adUserData === 'granted' ? 'GRANTED' : 'DENIED';
        }
        if (this.state.adPersonalization) {
            payload.ad_personalization = this.state.adPersonalization === 'granted' ? 'GRANTED' : 'DENIED';
        }
        return payload.ad_user_data || payload.ad_personalization ? payload : null;
    }
}

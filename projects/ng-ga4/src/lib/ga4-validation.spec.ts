import { appOnlyEventNameProblem, eventNameProblem, paramNameProblem, paramValueProblem, validateEventParams } from './ga4-validation';

describe('ga4-validation', () => {
    describe('eventNameProblem', () => {
        it('accepts ordinary names, up to 40 characters', () => {
            for (const name of ['login', 'file_download', 'Purchase2', 'a'.repeat(40)]) {
                expect(eventNameProblem(name)).withContext(name).toBeNull();
            }
        });

        it('accepts names in non-English letters', () => {
            for (const name of ['café', '購入', 'покупка', 'खरीदारी', 'café_2']) {
                expect(eventNameProblem(name)).withContext(name).toBeNull();
                expect(paramNameProblem(name)).withContext(name).toBeNull();
            }
        });

        it('rejects an empty or non-string name', () => {
            expect(eventNameProblem('')).toMatch(/non-empty/);
            expect(eventNameProblem(undefined)).toMatch(/non-empty/);
            expect(eventNameProblem(42)).toMatch(/non-empty/);
        });

        it('rejects a name over 40 characters', () => {
            expect(eventNameProblem('a'.repeat(41))).toMatch(/41 characters; the limit is 40/);
        });

        it('rejects characters other than letters, digits and underscores, and a leading digit', () => {
            for (const name of ['my event', 'my-event', '9lives', 'café!']) {
                expect(eventNameProblem(name)).withContext(name).toMatch(/must start with a letter/);
            }
        });

        it('rejects every reserved name from the Measurement Protocol reference', () => {
            for (const name of [
                'ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'ad_reward', 'adunit_exposure',
                'app_clear_data', 'app_exception', 'app_install', 'app_remove', 'app_store_refund',
                'app_update', 'app_upgrade', 'dynamic_link_app_open', 'dynamic_link_app_update',
                'dynamic_link_first_open', 'error', 'firebase_campaign', 'first_open', 'first_visit',
                'notification_dismiss', 'notification_foreground', 'notification_open', 'notification_receive',
                'os_update', 'session_start', 'user_engagement'
            ]) {
                expect(eventNameProblem(name)).withContext(name).toMatch(/reserved/);
            }
        });

        it('rejects the reserved prefixes', () => {
            for (const name of [
                'firebase_in_app_message_open', 'ga_custom', 'google_custom', '_custom', 'gtag.custom'
            ]) {
                expect(eventNameProblem(name)).withContext(name).toMatch(/reserved prefix/);
            }
        });

        it('allows custom names that merely start with notification_', () => {
            expect(eventNameProblem('notification_permission_granted')).toBeNull();
        });

        it('does not reject App-stream-only names, but flags them separately', () => {
            for (const name of ['ad_impression', 'in_app_purchase', 'screen_view']) {
                expect(eventNameProblem(name)).withContext(name).toBeNull();
                expect(appOnlyEventNameProblem(name)).withContext(name).toMatch(/App streams/);
            }
            expect(appOnlyEventNameProblem('login')).toBeNull();
        });
    });

    describe('paramNameProblem', () => {
        it('accepts ordinary names, up to 40 characters', () => {
            expect(paramNameProblem('method')).toBeNull();
            expect(paramNameProblem('a'.repeat(40))).toBeNull();
        });

        it('rejects a name over 40 characters', () => {
            expect(paramNameProblem('a'.repeat(41))).toMatch(/41 characters; the limit is 40/);
        });

        it('rejects firebase_conversion', () => {
            expect(paramNameProblem('firebase_conversion')).toMatch(/reserved by GA4/);
        });

        it('rejects the reserved prefixes', () => {
            for (const name of ['_x', 'firebase_x', 'ga_x', 'google_x', 'gtag.x']) {
                expect(paramNameProblem(name)).withContext(name).toMatch(/reserved prefix/);
            }
        });

        it('rejects invalid characters and empty names', () => {
            expect(paramNameProblem('')).toMatch(/empty/);
            expect(paramNameProblem('page-title')).toMatch(/must start with a letter/);
            expect(paramNameProblem('1st')).toMatch(/must start with a letter/);
        });
    });

    describe('paramValueProblem', () => {
        it('allows strings up to 100 characters and ignores non-strings', () => {
            expect(paramValueProblem('x', 'a'.repeat(100))).toBeNull();
            expect(paramValueProblem('x', 10 ** 120)).toBeNull();
            expect(paramValueProblem('items', [])).toBeNull();
        });

        it('does not look up Object.prototype members as limits', () => {
            expect(paramValueProblem('constructor', 'abc')).toBeNull();
            expect(paramValueProblem('toString', 'a'.repeat(101))).toMatch(/limit is 100/);
        });

        it('flags a string over 100 characters', () => {
            expect(paramValueProblem('x', 'a'.repeat(101))).toMatch(/101 characters; the limit is 100/);
        });

        it('applies the larger documented limits for page parameters', () => {
            expect(paramValueProblem('page_location', 'a'.repeat(1000))).toBeNull();
            expect(paramValueProblem('page_location', 'a'.repeat(1001))).toMatch(/limit is 1000/);
            expect(paramValueProblem('page_referrer', 'a'.repeat(421))).toMatch(/limit is 420/);
            expect(paramValueProblem('page_title', 'a'.repeat(300))).toBeNull();
            expect(paramValueProblem('page_title', 'a'.repeat(301))).toMatch(/limit is 300/);
        });
    });

    describe('validateEventParams', () => {
        it('passes valid params through untouched with no problems', () => {
            const result = validateEventParams({ method: 'email', value: 3 });
            expect(result.params).toEqual({ method: 'email', value: 3 });
            expect(result.problems).toEqual([]);
        });

        it('removes params with invalid names and reports each', () => {
            const result = validateEventParams({ method: 'email', ga_x: 1, 'bad-name': 2 });
            expect(result.params).toEqual({ method: 'email' });
            expect(result.problems).toEqual([
                jasmine.stringMatching(/^parameter name "ga_x" uses the reserved prefix "ga_"; it was removed$/),
                jasmine.stringMatching(/^parameter name "bad-name" must start with a letter.*; it was removed$/)
            ]);
        });

        it('keeps an over-long value but reports it', () => {
            const long = 'a'.repeat(150);
            const result = validateEventParams({ term: long });
            expect(result.params).toEqual({ term: long });
            expect(result.problems).toEqual([jasmine.stringMatching(/150 characters/)]);
        });

        it('reports more than 25 params without removing any', () => {
            const params: Record<string, number> = {};
            for (let i = 0; i < 26; i++) {
                params[`p${i}`] = i;
            }
            const result = validateEventParams(params);
            expect(Object.keys(result.params).length).toBe(26);
            expect(result.problems).toEqual([jasmine.stringMatching(/26 parameters; the limit is 25/)]);
        });

        it('does not count or keep undefined values, which never reach the wire', () => {
            const params: Record<string, unknown> = { kept: 1 };
            for (let i = 0; i < 30; i++) {
                params[`u${i}`] = undefined;
            }
            const result = validateEventParams(params);
            expect(result.params).toEqual({ kept: 1 });
            expect(result.problems).toEqual([]);
        });

        it('removes invalid names but collects nothing when report is false', () => {
            const params: Record<string, unknown> = { ga_x: 1, term: 'a'.repeat(150) };
            for (let i = 0; i < 30; i++) {
                params[`p${i}`] = i;
            }
            const result = validateEventParams(params, false);
            expect('ga_x' in result.params).toBeFalse();
            expect(Object.keys(result.params).length).toBe(31);
            expect(result.problems).toEqual([]);
        });

        it('does not count dropped params towards the limit', () => {
            const params: Record<string, number> = { _a: 0, _b: 0 };
            for (let i = 0; i < 25; i++) {
                params[`p${i}`] = i;
            }
            const result = validateEventParams(params);
            expect(result.problems.some(p => /parameters; the limit/.test(p))).toBeFalse();
        });
    });
});

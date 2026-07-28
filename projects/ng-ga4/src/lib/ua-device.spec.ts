import { deviceFromUserAgent } from './ua-device';

// Real user-agent strings. The fallback only runs where navigator.userAgentData is
// absent, so Safari and Firefox are the cases that matter most in practice — but
// older Chromium and the UA-CH-blocked path go through here too.
describe('deviceFromUserAgent', () => {
    describe('Safari', () => {
        it('reads macOS Safari', () => {
            const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';

            expect(deviceFromUserAgent(ua)).toEqual({
                category: 'desktop',
                operating_system: 'macOS',
                operating_system_version: '10.15.7',
                browser: 'Safari',
                browser_version: '17.4.1'
            });
        });

        it('reads iPhone Safari as mobile iOS', () => {
            const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

            expect(deviceFromUserAgent(ua)).toEqual({
                category: 'mobile',
                operating_system: 'iOS',
                operating_system_version: '17.4.1',
                browser: 'Safari',
                browser_version: '17.4.1'
            });
        });

        it('reads iPad Safari as tablet iOS', () => {
            const ua = 'Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

            const device = deviceFromUserAgent(ua);
            expect(device.category).toBe('tablet');
            expect(device.operating_system).toBe('iOS');
            expect(device.browser).toBe('Safari');
        });

        // Since iPadOS 13 an iPad in desktop mode is indistinguishable from a Mac by
        // UA alone; a touch-capable "Mac" is the standard disambiguation.
        it('treats a touch-capable Macintosh as an iPad in desktop mode', () => {
            const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

            expect(deviceFromUserAgent(ua, 5).category).toBe('tablet');
            expect(deviceFromUserAgent(ua, 0).category).toBe('desktop');
        });
    });

    describe('Firefox', () => {
        it('reads Firefox on Windows', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

            expect(deviceFromUserAgent(ua)).toEqual({
                category: 'desktop',
                operating_system: 'Windows',
                operating_system_version: '10',
                browser: 'Firefox',
                browser_version: '125.0'
            });
        });

        it('reads Firefox on Android as mobile', () => {
            const ua = 'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0';

            const device = deviceFromUserAgent(ua);
            expect(device.category).toBe('mobile');
            expect(device.operating_system).toBe('Android');
            expect(device.operating_system_version).toBe('14');
            expect(device.browser).toBe('Firefox');
        });

        it('reads Firefox on Linux', () => {
            const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';

            const device = deviceFromUserAgent(ua);
            expect(device.category).toBe('desktop');
            expect(device.operating_system).toBe('Linux');
            expect(device.browser).toBe('Firefox');
        });
    });

    // Every Chromium UA contains "Safari", and Edge/Opera/Samsung all contain
    // "Chrome", so match order is load-bearing: most specific wins.
    describe('Chromium family match order', () => {
        it('reports Edge, not Chrome, for a desktop Edge UA', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.65';

            const device = deviceFromUserAgent(ua);
            expect(device.browser).toBe('Edge');
            expect(device.browser_version).toBe('123.0.2420.65');
        });

        it('reports Opera, not Chrome, for an Opera UA', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 OPR/109.0.0.0';

            const device = deviceFromUserAgent(ua);
            expect(device.browser).toBe('Opera');
            expect(device.browser_version).toBe('109.0.0.0');
        });

        it('reports Samsung Internet, not Chrome, for a Samsung UA', () => {
            const ua = 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';

            const device = deviceFromUserAgent(ua);
            expect(device.browser).toBe('Samsung Internet');
            expect(device.browser_version).toBe('23.0');
            expect(device.category).toBe('mobile');
        });

        it('reports Chrome, not Safari, for a plain Chromium UA', () => {
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.114 Safari/537.36';

            const device = deviceFromUserAgent(ua);
            expect(device.browser).toBe('Chrome');
            expect(device.browser_version).toBe('89.0.4389.114');
        });

        it('reports Chrome for CriOS and Edge for EdgiOS on iOS', () => {
            const criOs = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1';
            const edgiOs = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/123.0.2420.90 Mobile/15E148 Safari/604.1';

            expect(deviceFromUserAgent(criOs).browser).toBe('Chrome');
            expect(deviceFromUserAgent(criOs).operating_system).toBe('iOS');
            expect(deviceFromUserAgent(edgiOs).browser).toBe('Edge');
        });
    });

    describe('device category', () => {
        it('reads an Android phone as mobile', () => {
            const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

            expect(deviceFromUserAgent(ua).category).toBe('mobile');
        });

        // Android tablets are exactly the Android UAs without the "Mobile" token.
        it('reads an Android tablet as tablet', () => {
            const ua = 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

            expect(deviceFromUserAgent(ua).category).toBe('tablet');
        });

        it('reads ChromeOS as desktop', () => {
            const ua = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

            const device = deviceFromUserAgent(ua);
            expect(device.category).toBe('desktop');
            expect(device.operating_system).toBe('Chrome OS');
        });
    });

    describe('older Windows releases', () => {
        it('maps NT version numbers to marketing versions', () => {
            const nt63 = 'Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.114 Safari/537.36';
            const nt61 = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.114 Safari/537.36';

            expect(deviceFromUserAgent(nt63).operating_system_version).toBe('8.1');
            expect(deviceFromUserAgent(nt61).operating_system_version).toBe('7');
        });
    });

    describe('unparseable input', () => {
        it('returns an empty object rather than guessing', () => {
            expect(deviceFromUserAgent('')).toEqual({});
            expect(deviceFromUserAgent('not a user agent at all')).toEqual({});
        });

        it('does not throw on undefined-ish input', () => {
            expect(() => deviceFromUserAgent(undefined as unknown as string)).not.toThrow();
            expect(deviceFromUserAgent(undefined as unknown as string)).toEqual({});
        });
    });
});

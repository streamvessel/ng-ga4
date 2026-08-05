import { Injector, NgZone, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { HttpClientTestingModule, HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { Router, NavigationEnd, NavigationStart } from '@angular/router';
import { Subject } from 'rxjs';
import { NgGa4Service } from './ng-ga4.service';
import { NG_GA4_CONFIG, NgGa4Config } from './ng-ga4.config';
import { isGtagClientId } from './ga-cookie';

const MOCK_UUID = '12345678-1234-1234-1234-123456789abc';
const MOCK_TIMESTAMP = 1700000000000;
const MOCK_SESSION_ID = Math.floor(MOCK_TIMESTAMP / 1000).toString();
// The web path now mints a brand-new client ID in gtag's own shape rather than a
// UUID (see loadOrCreateClientIdFromLocalStorage). randomClientIdSeed is stubbed
// to this value wherever a test needs the minted ID pinned exactly; the seed is
// deliberately different from the 1234567890 used by the clientIdSource: 'cookie'
// specs below so a test that forgets to stub cookie-adoption away can't pass by
// coincidence.
const MOCK_CLIENT_ID_SEED = 555555555;
const MOCK_MINTED_CLIENT_ID = `${MOCK_CLIENT_ID_SEED}.${Math.floor(MOCK_TIMESTAMP / 1000)}`;

const defaultConfig: NgGa4Config = {
    measurementId: 'G-TEST123',
    apiSecret: 'test-secret',
    enabled: true,
    isExtension: false,
    // Pin the bulk of the suite to the XHR transport so it can keep asserting on
    // payloads via HttpTestingController. The production-default 'beacon' transport
    // has its own focused block below.
    transport: 'xhr'
};

describe('NgGa4Service', () => {
    let service: NgGa4Service;
    let httpMock: HttpTestingController;
    let routerEvents$: Subject<any>;
    let mockLocalStorage: Record<string, string>;
    let originalChromeStorage: any;
    let mockCookieJar: string;
    let writtenCookies: string[];
    let cookieAcceptsDomain: (domain: string) => boolean;
    let cookiesEnabled: boolean;
    let pageEngaged: boolean;

    function configureTestBed(config?: Partial<NgGa4Config>, platformId?: string): void {
        // Reset here, not just in the top-level beforeEach, so a reconfigureTestBed()
        // mid-spec also gets a clean slate — writtenCookies in particular would
        // otherwise carry stale entries across a reconfigure.
        mockCookieJar = '';
        writtenCookies = [];
        cookieAcceptsDomain = () => true;
        cookiesEnabled = true;
        // Headless Chrome (as Karma runs it) reports document.hasFocus() === false,
        // which would otherwise start every timer disengaged and make the whole
        // engagement suite depend on window focus the CI runner never has. Stubbed
        // via a controllable flag, not a one-off spyOn, so individual specs can flip
        // it (Jasmine forbids spying on an already-spied method) to exercise blur.
        pageEngaged = true;

        routerEvents$ = new Subject<any>();

        const mockRouter = {
            events: routerEvents$.asObservable()
        };

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule],
            providers: [
                NgGa4Service,
                { provide: Router, useValue: mockRouter },
                { provide: NG_GA4_CONFIG, useValue: { ...defaultConfig, ...config } },
                // Only override when a test asks for it; the testing module's own
                // 'browser' value is what the rest of the suite should run under.
                ...(platformId ? [{ provide: PLATFORM_ID, useValue: platformId }] : [])
            ]
        });

        service = TestBed.inject(NgGa4Service);
        httpMock = TestBed.inject(HttpTestingController);

        // See the pageEngaged comment above: real hasFocus() is not controllable
        // (or even reliably true) under headless Karma, so the seam is stubbed here
        // for every spec, the same way getCookieJar/setCookie are below.
        spyOn(service as any, 'isPageEngaged').and.callFake(() => pageEngaged);

        // The engagement timer is built from monotonicNow() (performance.now() in
        // production), not Date.now(), so it keeps ticking across an OS suspend —
        // see the comment on monotonicNow(). jasmine.clock().tick() only advances
        // the mocked Date.now(), so every engagement spec would otherwise measure
        // 0 ms. Stubbed here, before any spec calls init() (EngagementTimer reads
        // the clock immediately in its constructor when started engaged), so
        // jasmine.clock().tick() keeps driving the existing specs unchanged.
        spyOn(service as any, 'monotonicNow').and.callFake(() => Date.now());

        // The service reads and writes cookies through seams precisely so tests can
        // stub them; mutating document.cookie for real would leak between specs and
        // make results depend on what the Karma browser already holds on localhost.
        spyOn(service as any, 'getCookieJar').and.callFake(() => cookiesEnabled ? mockCookieJar : '');
        spyOn(service as any, 'setCookie').and.callFake((cookie: string) => {
            // The attempt happens regardless — a real document.cookie assignment
            // with cookies disabled, in a cross-site iframe, or with a consent tool
            // stubbing document.cookie is a write the caller believes succeeded.
            writtenCookies.push(cookie);
            if (!cookiesEnabled) {
                // Silently discarded: the jar never changes, exactly like a browser
                // that ignores document.cookie assignments entirely.
                return;
            }
            // Emulate a browser refusing a cookie scoped to a public suffix: only
            // domains the test declares acceptable actually land in the jar.
            const domain = /;\s*domain=\.?([^;]+)/.exec(cookie)?.[1];
            if (domain && !cookieAcceptsDomain(domain)) {
                return;
            }
            const [pair] = cookie.split(';');
            const maxAgeZero = /;\s*max-age=0\b/.test(cookie);
            const name = pair.slice(0, pair.indexOf('='));
            const others = mockCookieJar
                .split(';')
                .map(part => part.trim())
                .filter(part => part && part.slice(0, part.indexOf('=')) !== name);
            mockCookieJar = (maxAgeZero ? others : [...others, pair.trim()]).join('; ');
        });
    }

    function reconfigureTestBed(config?: Partial<NgGa4Config>, platformId?: string): void {
        jasmine.clock().uninstall();
        httpMock.verify();
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(MOCK_TIMESTAMP));
        // The outgoing instance's listeners (visibilitychange/pagehide) would
        // otherwise dangle on document/window past this reconfigure — see the
        // afterEach below for why that matters.
        service?.ngOnDestroy();
        configureTestBed(config, platformId);
    }

    function setupChromeMock(localStore?: Record<string, any>, sessionStore?: Record<string, any>): void {
        const chromeLocal = localStore || {};
        const chromeSession = sessionStore || {};

        (window as any).chrome.storage = {
            local: {
                get: (keys: string[]) => Promise.resolve(
                    keys.reduce((acc: any, k: string) => { if (chromeLocal[k] !== undefined) acc[k] = chromeLocal[k]; return acc; }, {})
                ),
                set: (items: any) => { Object.assign(chromeLocal, items); return Promise.resolve(); },
                remove: (keys: string[]) => { for (const k of keys) { delete chromeLocal[k]; } return Promise.resolve(); }
            },
            session: {
                get: (keys: string[]) => Promise.resolve(
                    keys.reduce((acc: any, k: string) => { if (chromeSession[k] !== undefined) acc[k] = chromeSession[k]; return acc; }, {})
                ),
                set: (items: any) => { Object.assign(chromeSession, items); return Promise.resolve(); },
                remove: (keys: string[]) => { for (const k of keys) { delete chromeSession[k]; } return Promise.resolve(); }
            }
        };
    }

    interface DeferredChromeMock {
        /** Labels of the operations that have actually been invoked, in order. */
        calls: string[];
        /** Resolve the oldest still-pending operation, applying its mutation. */
        release(): void;
        /** Reject the oldest still-pending operation. */
        rejectNext(err?: unknown): void;
        /**
         * Resolve every operation, including ones not yet queued.
         *
         * Chained links do not register with the mock until their turn comes, so
         * a single pass drains only what was already pending and the rest of the
         * chain never settles — which hangs `flushStorage()` rather than failing
         * it. Hence the drain-and-retry loop.
         */
        releaseAll(): Promise<void>;
        localStore: Record<string, any>;
        sessionStore: Record<string, any>;
    }

    // The existing setupChromeMock resolves every write immediately, so it cannot
    // distinguish "serialised" from "all issued at once". This one holds each
    // operation open until the test releases it.
    function setupDeferredChromeMock(
        localStore: Record<string, any> = {},
        sessionStore: Record<string, any> = {}
    ): DeferredChromeMock {
        const calls: string[] = [];
        const pending: Array<{ settle: (reject?: unknown) => void }> = [];

        const defer = (label: string, apply: () => void) => {
            calls.push(label);
            return new Promise<void>((resolve, reject) => {
                pending.push({
                    settle: (rejectWith?: unknown) => {
                        if (rejectWith !== undefined) {
                            reject(rejectWith);
                            return;
                        }
                        apply();
                        resolve();
                    }
                });
            });
        };

        const area = (store: Record<string, any>, name: string) => ({
            get: (keys: string[]) => Promise.resolve(
                keys.reduce((acc: any, k: string) => { if (store[k] !== undefined) acc[k] = store[k]; return acc; }, {})
            ),
            set: (items: any) => defer(`${name}.set:${Object.keys(items).join(',')}`, () => Object.assign(store, items)),
            remove: (keys: string[]) => defer(`${name}.remove:${keys.join(',')}`, () => { for (const k of keys) { delete store[k]; } })
        });

        (window as any).chrome.storage = { local: area(localStore, 'local'), session: area(sessionStore, 'session') };

        return {
            calls,
            localStore,
            sessionStore,
            release: () => pending.shift()?.settle(),
            rejectNext: (err: unknown = new Error('storage failure')) => pending.shift()?.settle(err),
            releaseAll: async () => {
                // Bounded so a genuine feedback loop fails the test instead of
                // hanging it. Nothing in the library writes in response to a
                // write, so five rounds is far beyond any real chain depth.
                for (let round = 0; round < 5 && pending.length; round++) {
                    while (pending.length) { pending.shift()!.settle(); }
                    await drainMicrotasks();
                }
            }
        };
    }

    // The chain is pure microtasks, and jasmine.clock() has mocked setTimeout, so
    // draining means yielding the microtask queue — not a timer.
    async function drainMicrotasks(): Promise<void> {
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
    }

    function clearChromeMock(): void {
        if (originalChromeStorage !== undefined) {
            (window as any).chrome.storage = originalChromeStorage;
        } else {
            delete (window as any).chrome.storage;
        }
    }

    beforeEach(() => {
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(MOCK_TIMESTAMP));

        mockLocalStorage = {};
        spyOn(localStorage, 'getItem').and.callFake((key: string) => mockLocalStorage[key] || null);
        spyOn(localStorage, 'setItem').and.callFake((key: string, value: string) => { mockLocalStorage[key] = value; });
        // Deletion (consent withdrawal) is a first-class path now. Without this spy
        // removeItem would hit the real localStorage while reads come from
        // mockLocalStorage, so a delete would appear to silently do nothing.
        spyOn(localStorage, 'removeItem').and.callFake((key: string) => { delete mockLocalStorage[key]; });

        spyOn(crypto, 'randomUUID').and.returnValue(MOCK_UUID as `${string}-${string}-${string}-${string}-${string}`);

        // Save original chrome.storage (if any) for restoration
        originalChromeStorage = (window as any).chrome?.storage;

        configureTestBed();
    });

    afterEach(() => {
        // Specs that call init() register visibilitychange/pagehide/focus/blur
        // listeners on the real document/window. Without this, ~120 specs' worth of
        // listeners accumulate across the Karma page, each retaining a dead service
        // and its injector — benign under headless Chrome (isPageEngaged is stubbed,
        // see pageEngaged above) but a leak that would flush through un-spied
        // transports and fire real requests at google-analytics.com in a headed or
        // backgrounded run.
        service?.ngOnDestroy();
        httpMock.verify();
        jasmine.clock().uninstall();
        clearChromeMock();
    });

    // --- init() ---

    describe('init()', () => {
        it('should not initialize when disabled', async () => {
            reconfigureTestBed({ enabled: false });

            await service.init();
            service.trackPageView('/test');
            httpMock.expectNone(() => true);
        });

        it('should create and store a client ID in localStorage, minted in gtag\'s shape', async () => {
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            await service.init();

            expect(crypto.randomUUID).not.toHaveBeenCalled();
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_client_id', MOCK_MINTED_CLIENT_ID);
        });

        // Guards the "creation only" half of the change: an install that already
        // has an ID keeps it, whatever its shape — a stored legacy UUID is not
        // upgraded to gtag's shape on the next load.
        it('should reuse an existing UUID-shaped client ID unchanged', async () => {
            mockLocalStorage['ga_client_id'] = MOCK_UUID;

            await service.init();
            service.trackPageView('/test');

            expect(localStorage.getItem).toHaveBeenCalledWith('ga_client_id');
            expect(localStorage.setItem).not.toHaveBeenCalledWith('ga_client_id', jasmine.anything());
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.client_id).toBe(MOCK_UUID);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should load client ID from chrome.storage.local when isExtension', async () => {
            reconfigureTestBed({ isExtension: true });

            setupChromeMock({ ga_client_id: 'chrome-client-id' });

            await service.init();

            service.trackPageView('/test');
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.client_id).toBe('chrome-client-id');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should create client ID in chrome.storage.local when not found', async () => {
            reconfigureTestBed({ isExtension: true });

            const chromeLocal: Record<string, any> = {};
            setupChromeMock(chromeLocal);

            await service.init();
            expect(chromeLocal['ga_client_id']).toBe(MOCK_UUID);
        });

        it('should fallback to localStorage when chrome.storage not available', async () => {
            reconfigureTestBed({ isExtension: true });
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            // Ensure chrome.storage is not set
            clearChromeMock();

            await service.init();
            // The localStorage fallback mints in gtag's shape same as the direct web
            // path, not a UUID — see loadOrCreateClientIdFromLocalStorage.
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_client_id', MOCK_MINTED_CLIENT_ID);
        });
    });

    // --- client ID source ---

    describe('client ID source', () => {
        function sentClientId(): string {
            service.trackPageView('/test');
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const clientId = req.request.body.client_id;
            req.flush('', { status: 204, statusText: 'No Content' });
            return clientId;
        }

        it('adopts the client ID from a gtag _ga cookie by default', async () => {
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';

            await service.init();

            expect(sentClientId()).toBe('1234567890.1700000000');
        });

        // The cookie is the durable store for an ID we don't own: mirroring it into
        // localStorage would let it outlive _ga, so deleting the cookie would fail
        // to reset identity.
        it('does not mirror an adopted cookie ID into localStorage', async () => {
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';

            await service.init();

            expect(localStorage.setItem)
                .not.toHaveBeenCalledWith('ga_client_id', jasmine.any(String));
        });

        it('ignores gtag\'s _ga_<STREAM> session cookie when no _ga is present', async () => {
            mockCookieJar = '_ga_ABC123=GS1.1.1700000000.1.0.1700000000.0.0.0';
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            await service.init();

            expect(sentClientId()).toBe(MOCK_MINTED_CLIENT_ID);
        });

        it('falls back to localStorage when _ga is malformed', async () => {
            mockCookieJar = '_ga=garbage';
            mockLocalStorage['ga_client_id'] = 'existing-id';

            await service.init();

            expect(sentClientId()).toBe('existing-id');
        });

        it('falls back to localStorage when reading the cookie jar throws', async () => {
            (service as any).getCookieJar.and.throwError('denied');
            mockLocalStorage['ga_client_id'] = 'existing-id';

            await service.init();

            expect(sentClientId()).toBe('existing-id');
        });

        it('writes no cookie by default', async () => {
            await service.init();

            expect(writtenCookies).toEqual([]);
        });

        it('ignores a present cookie under clientIdSource: storage', async () => {
            reconfigureTestBed({ clientIdSource: 'storage' });
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            await service.init();

            // A distinct seed from the cookie's own "1234567890" so this assertion
            // cannot pass by coincidence if the cookie were read instead of ignored.
            expect(sentClientId()).toBe(MOCK_MINTED_CLIENT_ID);
        });

        it('keeps using chrome.storage for extensions even with a _ga cookie present', async () => {
            reconfigureTestBed({ isExtension: true });
            setupChromeMock({ ga_client_id: 'chrome-client-id' });
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';

            await service.init();

            expect(sentClientId()).toBe('chrome-client-id');
        });

        it('writes the existing stored ID to _ga under auto + writeGaCookie', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            mockLocalStorage['ga_client_id'] = 'existing-id';
            cookieAcceptsDomain = (domain) => domain === 'example.com';
            spyOn(service as any, 'getHostname').and.returnValue('www.example.com');

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toContain('_ga=GA1.2.existing-id');
            expect(gaCookie).toContain('domain=.example.com');
            expect(gaCookie).toContain('max-age=63072000');
            expect(gaCookie).toContain('path=/');
            expect(gaCookie).toContain('SameSite=Lax');
            // Identity is preserved: writing a cookie must not re-identify the user.
            expect(sentClientId()).toBe('existing-id');
        });

        // Browsers refuse cookies on public suffixes, and that refusal is the only
        // public-suffix oracle available on the client.
        it('skips candidate domains the browser refuses', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            cookieAcceptsDomain = (domain) => domain === 'example.co.uk';
            spyOn(service as any, 'getHostname').and.returnValue('www.example.co.uk');

            await service.init();

            expect(writtenCookies.find(c => c.startsWith('_ga='))).toContain('domain=.example.co.uk');
        });

        it('writes without a domain attribute on a single-label host', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toContain('_ga=GA1.1.');
            expect(gaCookie).not.toContain('domain=');
        });

        it('does not overwrite a _ga cookie that already exists', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';

            await service.init();

            expect(writtenCookies.filter(c => c.startsWith('_ga='))).toEqual([]);
        });

        it('mints a gtag-format ID and writes it under clientIdSource: cookie', async () => {
            reconfigureTestBed({ clientIdSource: 'cookie' });
            // Deliberately present: 'cookie' ignores it, which re-identifies that user
            // once — the reason it is not the default.
            mockLocalStorage['ga_client_id'] = 'existing-id';
            spyOn(service as any, 'getHostname').and.returnValue('localhost');
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(1234567890);

            await service.init();

            expect(sentClientId()).toBe(`1234567890.${Math.floor(MOCK_TIMESTAMP / 1000)}`);
            expect(writtenCookies.find(c => c.startsWith('_ga='))).toBeDefined();
        });

        it('writes no cookie under clientIdSource: storage even with writeGaCookie', async () => {
            reconfigureTestBed({ clientIdSource: 'storage', writeGaCookie: true });

            await service.init();

            // No cookie write of any kind — not even domain-discovery probes, which
            // this path must never run.
            expect(writtenCookies).toEqual([]);
        });

        it('writes no cookie for extensions even with writeGaCookie', async () => {
            reconfigureTestBed({ isExtension: true, writeGaCookie: true });
            setupChromeMock({});

            await service.init();

            // No cookie write of any kind — not even domain-discovery probes, which
            // this path must never run.
            expect(writtenCookies).toEqual([]);
        });

        // Spec 5 stubs this for determinism, so nothing otherwise exercises the
        // modulo arithmetic — and an off-by-one here would be invisible.
        it('draws a client-ID seed inside gtag\'s range', () => {
            for (let i = 0; i < 500; i++) {
                const seed = (service as any).randomClientIdSeed();
                expect(Number.isInteger(seed)).toBe(true);
                expect(seed).toBeGreaterThanOrEqual(1);
                expect(seed).toBeLessThanOrEqual(2147483647);
            }
        });

        // A brand-new user has no identity to preserve, so there is no reason to
        // write a shape gtag.js may reject and rewrite: the payload here is minted
        // in gtag's own <random>.<seconds> shape, not a UUID, which is the actual
        // point of this change — pinned directly via isGtagClientId rather than
        // only implied by the other specs in this file.
        it('mints a gtag-shaped ID, not a UUID, for a user with no prior identity', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toContain(`_ga=GA1.1.${MOCK_MINTED_CLIENT_ID}`);
            const mintedId = gaCookie!.slice(gaCookie!.indexOf('GA1.1.') + 'GA1.1.'.length).split(';')[0];
            expect(isGtagClientId(mintedId)).toBe(true);
            expect(crypto.randomUUID).not.toHaveBeenCalled();
        });

        it('replaces a malformed _ga rather than leaving it', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            mockCookieJar = '_ga=garbage';
            spyOn(service as any, 'getHostname').and.returnValue('localhost');
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            await service.init();

            expect(writtenCookies.find(c => c.startsWith('_ga=')))
                .toContain(`_ga=GA1.1.${MOCK_MINTED_CLIENT_ID}`);
        });

        // encodeURIComponent on write exists to close a read/write asymmetry
        // (readCookieValue decodes), and nothing exercised it.
        it('percent-encodes a client ID that would otherwise inject cookie attributes', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            mockLocalStorage['ga_client_id'] = 'evil; max-age=0';
            spyOn(service as any, 'getHostname').and.returnValue('localhost');

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toContain('evil%3B%20max-age%3D0');
            expect(gaCookie).toContain('max-age=63072000');
        });

        // A probe left behind would be a stray cookie on every user's domain.
        it('cleans up the domain probe once a candidate sticks', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            cookieAcceptsDomain = (domain) => domain === 'example.com';
            spyOn(service as any, 'getHostname').and.returnValue('www.example.com');

            await service.init();

            expect(writtenCookies.some(c => c.includes('_ng_ga4_probe_') && c.includes('max-age=0')))
                .toBe(true);
            expect(mockCookieJar).not.toContain('_ng_ga4_probe_');
        });

        it('adopts a present _ga under clientIdSource: cookie without rewriting it', async () => {
            reconfigureTestBed({ clientIdSource: 'cookie' });
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';

            await service.init();

            expect(sentClientId()).toBe('1234567890.1700000000');
            expect(writtenCookies.filter(c => c.startsWith('_ga='))).toEqual([]);
        });

        it('warns and falls back to auto for an unrecognised clientIdSource', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ clientIdSource: 'Cookie' as any });
            mockCookieJar = '_ga=GA1.1.1234567890.1700000000';

            await service.init();

            expect(console.warn).toHaveBeenCalledWith(jasmine.stringMatching(/^\[ng-ga4\].*Cookie/));
            // Falls back to 'auto', which still adopts a present cookie.
            expect(sentClientId()).toBe('1234567890.1700000000');
        });

        // A service that mints a fresh identity, or resurrects a deleted cookie, on
        // the *second* load looks identical to a correct one on the first, so this
        // block exercises two loads: reconfigureTestBed() simulates a fresh service
        // instance backed by the same mockLocalStorage, with the cookie jar under the
        // test's control.
        describe('across multiple page loads', () => {
            it('keeps the same client_id under clientIdSource: cookie across two inits when the cookie write is rejected', async () => {
                reconfigureTestBed({ clientIdSource: 'cookie' });
                spyOn(service as any, 'getHostname').and.returnValue('www.example.com');
                spyOn(service as any, 'randomClientIdSeed').and.returnValue(1234567890);
                cookieAcceptsDomain = () => false;

                await service.init();
                const first = sentClientId();

                // Simulates the write never landing: cookies disabled, a cross-site
                // iframe, or a consent tool stubbing document.cookie before consent.
                reconfigureTestBed({ clientIdSource: 'cookie' });
                spyOn(service as any, 'getHostname').and.returnValue('www.example.com');
                cookieAcceptsDomain = () => false;

                await service.init();
                const second = sentClientId();

                expect(second).toBe(first);
            });

            it('keeps the same client_id under clientIdSource: cookie across two inits when the cookie write succeeds', async () => {
                reconfigureTestBed({ clientIdSource: 'cookie' });
                spyOn(service as any, 'getHostname').and.returnValue('localhost');
                spyOn(service as any, 'randomClientIdSeed').and.returnValue(1234567890);

                await service.init();
                const first = sentClientId();
                const gaCookiePair = writtenCookies.find(c => c.startsWith('_ga='))!.split(';')[0];

                reconfigureTestBed({ clientIdSource: 'cookie' });
                // Simulates the cookie surviving to the next page load.
                mockCookieJar = gaCookiePair;
                spyOn(service as any, 'getHostname').and.returnValue('localhost');

                await service.init();
                const second = sentClientId();

                expect(second).toBe(first);
            });

            // Not mirrored into localStorage (see 'does not mirror an adopted cookie
            // ID into localStorage' above), so nothing remembers the deleted identity:
            // the next load mints a fresh ID and writes it to _ga, the same way
            // deleting _ga resets identity under gtag.js itself.
            it('writes a freshly minted _ga after the user deletes it, not the previously adopted ID', async () => {
                // First load: adopt gtag's cookie.
                mockCookieJar = '_ga=GA1.1.1234567890.1700000000';
                await service.init();
                expect(sentClientId()).toBe('1234567890.1700000000');

                // Second load: the user's consent tool deleted _ga, and this time
                // writeGaCookie is on.
                reconfigureTestBed({ writeGaCookie: true });
                mockCookieJar = '';
                spyOn(service as any, 'getHostname').and.returnValue('localhost');

                await service.init();

                const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
                expect(gaCookie).toBeDefined();
                expect(gaCookie).not.toContain('1234567890.1700000000');
            });

            it('sends a client_id that differs from the adopted one after the user deletes _ga and reloads', async () => {
                // First load: adopt gtag's cookie.
                mockCookieJar = '_ga=GA1.1.1234567890.1700000000';
                await service.init();
                const adopted = sentClientId();

                // Second load: the user's consent tool deleted _ga.
                reconfigureTestBed();
                mockCookieJar = '';

                await service.init();
                const afterDeletion = sentClientId();

                expect(afterDeletion).not.toBe(adopted);
            });

            it('still writes _ga for a locally-owned client_id on a single-label host', async () => {
                reconfigureTestBed({ writeGaCookie: true });
                mockLocalStorage['ga_client_id'] = 'existing-local-id';
                spyOn(service as any, 'getHostname').and.returnValue('localhost');

                await service.init();

                expect(writtenCookies.find(c => c.startsWith('_ga=')))
                    .toContain('_ga=GA1.1.existing-local-id');
            });

            // The two specs above model a domain-scoped rejection (cookieAcceptsDomain).
            // This models the case they can't: a browser with cookies disabled
            // outright, a cross-site iframe, or a consent tool stubbing document.cookie
            // before consent — a write is attempted, silently discarded, and there is
            // nothing to read back.
            it('keeps the same client_id under clientIdSource: cookie across two inits when cookies are disabled entirely', async () => {
                reconfigureTestBed({ clientIdSource: 'cookie' });
                cookiesEnabled = false;
                spyOn(service as any, 'getHostname').and.returnValue('www.example.com');
                spyOn(service as any, 'randomClientIdSeed').and.returnValue(1234567890);

                await service.init();
                const first = sentClientId();

                // Simulates the second page load: same config, same localStorage
                // (mockLocalStorage persists across reconfigureTestBed), cookies still
                // disabled. cookiesEnabled resets to true on reconfigureTestBed, so it
                // must be set again here.
                reconfigureTestBed({ clientIdSource: 'cookie' });
                cookiesEnabled = false;
                spyOn(service as any, 'getHostname').and.returnValue('www.example.com');

                await service.init();
                const second = sentClientId();

                expect(second).toBe(first);
            });
        });

        // Companion to the spec above: with cookies disabled, a write is attempted
        // but the browser has nothing to hand back, so every domain probe in
        // discoverCookieDomain fails the same way a public-suffix refusal would.
        it('writes no _ga cookie when cookies are disabled, since every domain probe fails', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            cookiesEnabled = false;
            spyOn(service as any, 'getHostname').and.returnValue('www.example.com');

            await expectAsync(service.init()).toBeResolved();

            expect(writtenCookies.filter(c => c.startsWith('_ga='))).toEqual([]);
        });
    });

    // --- engagement time ---

    describe('engagement time', () => {
        function sentParams(): Record<string, any> {
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const params = req.request.body.events[0].params;
            req.flush('', { status: 204, statusText: 'No Content' });
            return params;
        }

        // The hide flush forces the beacon transport so it survives unload, which
        // means it never reaches HttpClient and HttpTestingController cannot see it.
        // Neutralise both beacon and fetch(keepalive) so the send falls through to
        // XHR, where the suite can assert on the payload. That the flush really does
        // force the beacon is covered separately by its own spec.
        function observeFlushViaXhr(): void {
            spyOn(service as any, 'getNavigator').and.returnValue({});
            spyOn(service as any, 'getFetch').and.returnValue(undefined);
        }

        it('reports the foreground time accrued before a page view', async () => {
            await service.init();

            jasmine.clock().tick(5000);
            service.trackPageView('/test');

            expect(sentParams()['engagement_time_msec']).toBe(5000);
        });

        it('reports the foreground time accrued before a custom event', async () => {
            await service.init();

            jasmine.clock().tick(2500);
            service.trackEvent('cta_click');

            expect(sentParams()['engagement_time_msec']).toBe(2500);
        });

        // Time since the previous hit, as gtag's _et reports — not a running
        // total, which would multiply-count the same seconds.
        it('reports only the time since the previous hit', async () => {
            await service.init();

            jasmine.clock().tick(3000);
            service.trackEvent('first');
            expect(sentParams()['engagement_time_msec']).toBe(3000);

            jasmine.clock().tick(1000);
            service.trackEvent('second');
            expect(sentParams()['engagement_time_msec']).toBe(1000);
        });

        it('lets an explicit caller value override the measurement', async () => {
            await service.init();

            jasmine.clock().tick(5000);
            service.trackEvent('video_progress', { engagement_time_msec: 42 });

            expect(sentParams()['engagement_time_msec']).toBe(42);
        });

        // The spec above only proves 42 is what gets sent, which passes whether or
        // not the measured 5000ms was also drained. This is the part that actually
        // catches the bug: a sent hit closes the engagement interval no matter what
        // value it reports, so the override hit must still consume the accumulator.
        // If it didn't, the interval would stay open across it, and this later,
        // unoverridden hit would report time since *two* hits ago (42's hit plus
        // this one) instead of just the time since the override — silently
        // inflating the session total by the sum of every override a caller makes.
        it('consumes the measured time even when the caller overrides the reported value', async () => {
            await service.init();

            jasmine.clock().tick(5000);
            service.trackEvent('video_progress', { engagement_time_msec: 42 });
            expect(sentParams()['engagement_time_msec']).toBe(42);

            // No time ticks here: the override hit already closed the interval, so
            // this immediate next hit has accrued nothing since it and must report 0
            // — not the stale 5000ms the accumulator held before the override.
            service.trackEvent('later');
            expect(sentParams()['engagement_time_msec']).toBe(0);
        });

        it('sends the engagement event when the page hides', async () => {
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(7000);

            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const event = req.request.body.events[0];
            expect(event.name).toBe('page_engagement');
            expect(event.params.engagement_time_msec).toBe(7000);
            expect(event.params.session_id).toBeDefined();
            expect(event.params.page_location).toBeDefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        // pagehide's listener calls setEngaged(false) before flushing — the
        // bfcache guard — so a bfcache restore minutes later can't have that
        // dead time reopened and counted as foreground time. Nothing else in
        // this suite dispatches pagehide, so nothing else exercises that call.
        it('closes the engaged interval on pagehide so time afterwards does not count', async () => {
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            window.dispatchEvent(new Event('pagehide'));
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            // Simulates a bfcache restore: time passes with the interval already
            // closed by setEngaged(false), and nothing re-engaged it.
            jasmine.clock().tick(10000);

            service.trackEvent('after_pagehide');
            expect(sentParams()['engagement_time_msec']).toBe(0);
        });

        // pagehide often follows visibilitychange. The accumulator is already
        // drained by the first flush, so the second must be silent — that is the
        // deduplication, rather than a separate guard.
        it('sends nothing on a second flush with no time accrued', async () => {
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(3000);

            (service as any).flushEngagement();
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            (service as any).flushEngagement();
            httpMock.expectNone(() => true);
        });

        it('sends nothing when no time has accrued at all', async () => {
            await service.init();

            (service as any).flushEngagement();

            httpMock.expectNone(() => true);
        });

        // MIN_ENGAGEMENT_FLUSH_MS floors a visibilitychange-driven flush — someone
        // rapidly hiding and showing the tab would otherwise emit an event per
        // cycle — but the time itself must not be discarded: it stays in the
        // accumulator and rides out on the next flush or hit. Blur is not the
        // vehicle for this any more (see below): it never flushes, whatever the
        // accrued time, so this floor now only bites visibilitychange and pagehide.
        it('does not flush a visibilitychange below the one-second floor', async () => {
            await service.init();
            jasmine.clock().tick(500);

            pageEngaged = false;
            document.dispatchEvent(new Event('visibilitychange'));

            httpMock.expectNone(() => true);
        });

        it('preserves sub-floor time for a later hit instead of discarding it', async () => {
            await service.init();
            jasmine.clock().tick(500);

            pageEngaged = false;
            document.dispatchEvent(new Event('visibilitychange'));
            httpMock.expectNone(() => true);

            pageEngaged = true;
            document.dispatchEvent(new Event('visibilitychange'));
            jasmine.clock().tick(200);

            service.trackEvent('after_short_hide');
            expect(sentParams()['engagement_time_msec']).toBe(700);
        });

        it('does not send when sendEngagementOnHide is false, but keeps the accrued time for later', async () => {
            reconfigureTestBed({ sendEngagementOnHide: false });
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            httpMock.expectNone(() => true);

            // The sendEngagementOnHide guard sits above consumeEngagementTime()
            // precisely so a no-op flush does not drain it — the time must still
            // be there for the next real hit to report.
            service.trackEvent('later');
            expect(sentParams()['engagement_time_msec']).toBe(4000);
        });

        it('honours a custom engagementEventName', async () => {
            reconfigureTestBed({ engagementEventName: 'dwell' });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('dwell');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        // engagementEventName's JSDoc says it cannot be 'user_engagement' (the
        // Measurement Protocol reserves that name, along with these others), but
        // nothing validated that before this spec — GA4 returns 2xx and silently
        // drops a hit carrying a reserved or empty name, the worst failure mode.
        it('warns and falls back to page_engagement for an empty engagementEventName', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ engagementEventName: '' });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            expect(console.warn).toHaveBeenCalledWith(jasmine.stringMatching(/^\[ng-ga4\].*engagementEventName/));
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_engagement');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('warns and falls back to page_engagement for each reserved Measurement Protocol event name', async () => {
            spyOn(console, 'warn');
            // A sample of the widened reserved list, not just the original four —
            // 'error' and 'screen_view' in particular are names a consumer could
            // plausibly reach for without realising GA4 reserves them.
            for (const reserved of ['user_engagement', 'session_start', 'first_visit', 'first_open', 'error', 'screen_view']) {
                reconfigureTestBed({ engagementEventName: reserved });
                observeFlushViaXhr();
                await service.init();
                jasmine.clock().tick(4000);

                (service as any).flushEngagement();

                expect(console.warn).toHaveBeenCalledWith(jasmine.stringMatching(new RegExp(`^\\[ng-ga4\\].*${reserved}`)));
                const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
                expect(req.request.body.events[0].name).toBe('page_engagement');
                req.flush('', { status: 204, statusText: 'No Content' });
            }
        });

        // The old validation only checked a four-name blocklist and let everything
        // else through verbatim. A reviewer confirmed GA4 accepts and silently
        // drops every one of these — 2xx, no error, hit just gone.
        it('rejects a name with the ga_ prefix', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ engagementEventName: 'ga_dwell' });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            expect(console.warn).toHaveBeenCalledWith(jasmine.stringMatching(/^\[ng-ga4\].*ga_dwell/));
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_engagement');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('rejects a name containing a space', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ engagementEventName: 'my event' });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_engagement');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('rejects a name starting with a digit', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ engagementEventName: '9lives' });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_engagement');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('rejects a name longer than 40 characters', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ engagementEventName: 'a'.repeat(41) });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_engagement');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('accepts a name exactly 40 characters long', async () => {
            spyOn(console, 'warn');
            const name = 'a'.repeat(40);
            reconfigureTestBed({ engagementEventName: name });
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            (service as any).flushEngagement();

            expect(console.warn).not.toHaveBeenCalled();
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe(name);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        // Validation runs once, in init(), not on every flush — otherwise a
        // misconfigured name would warn on every window switch.
        it('warns once for an invalid engagementEventName, not once per flush', async () => {
            spyOn(console, 'warn');
            reconfigureTestBed({ engagementEventName: 'ga_dwell' });
            observeFlushViaXhr();
            await service.init();

            jasmine.clock().tick(4000);
            (service as any).flushEngagement();
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            jasmine.clock().tick(4000);
            (service as any).flushEngagement();
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            const engagementNameWarnings = (console.warn as jasmine.Spy).calls.allArgs()
                .filter(args => /engagementEventName/.test(String(args[0])));
            expect(engagementNameWarnings.length).toBe(1);
        });

        it('flushes when a visibilitychange to hidden fires', async () => {
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(6000);

            pageEngaged = false;
            document.dispatchEvent(new Event('visibilitychange'));

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.engagement_time_msec).toBe(6000);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        // Switching to another window or application leaves this tab visible but
        // unfocused — visibilitychange never fires, so this is the case that
        // motivates isPageEngaged() combining both signals in the first place.
        it('does not accrue time while the window is blurred', async () => {
            pageEngaged = false;
            await service.init();

            jasmine.clock().tick(9000);
            service.trackEvent('after_blur');

            expect(sentParams()['engagement_time_msec']).toBe(0);
        });

        // Inverts the old expectation: a blur used to flush immediately, which
        // measured as ten network hits for ten alt-tab cycles. Blur now only stops
        // the clock — the accrued time is retained in the accumulator, not sent,
        // and shows up on whatever hit comes next.
        it('accrues time on blur but sends nothing, until the next trackEvent', async () => {
            await service.init();
            jasmine.clock().tick(8000);

            pageEngaged = false;
            window.dispatchEvent(new Event('blur'));

            httpMock.expectNone(() => true);

            service.trackEvent('after_blur');
            expect(sentParams()['engagement_time_msec']).toBe(8000);
        });

        it('resumes accumulation when a focus event follows a blur, keeping the pre-blur time too', async () => {
            await service.init();
            jasmine.clock().tick(2000);

            pageEngaged = false;
            window.dispatchEvent(new Event('blur'));
            httpMock.expectNone(() => true);   // blur never flushes — see above

            jasmine.clock().tick(4000);   // blurred — must not count
            pageEngaged = true;
            window.dispatchEvent(new Event('focus'));
            jasmine.clock().tick(3000);   // engaged again

            service.trackEvent('after_focus');
            // The 2000ms accrued before the blur was never flushed away, so it
            // rides out on this hit alongside the 3000ms accrued after refocusing.
            expect(sentParams()['engagement_time_msec']).toBe(5000);
        });

        it('forces the beacon transport for the hide flush even under transport: xhr', async () => {
            await service.init();
            jasmine.clock().tick(3000);
            const beaconSpy = spyOn(service as any, 'trySendBeacon').and.returnValue(true);

            (service as any).flushEngagement();

            expect(beaconSpy).toHaveBeenCalled();
            expect(JSON.parse(beaconSpy.calls.mostRecent().args[1] as string).events[0].name).toBe('page_engagement');
            httpMock.expectNone(() => true);
        });

        it('does not roll the session when flushing after the timeout', async () => {
            observeFlushViaXhr();
            await service.init();
            const before = (service as any).sessionNumber;

            jasmine.clock().tick(31 * 60 * 1000);
            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_number).toBe(before);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        // The hide path is the one hit path the #16 adoption fix didn't reach: the
        // expiry guard below used to be evaluated against the pre-adoption in-memory
        // timestamp, so a tab sitting idle-but-visible past the timeout would skip
        // adoption entirely and emit page_engagement for a session another tab had
        // already rolled past — even though storage held a perfectly live one.
        it('adopts a newer session from storage before judging expiry on flush', async () => {
            mockLocalStorage['ga_session_id'] = 'S1';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP);
            mockLocalStorage['ga_session_number'] = '3';
            observeFlushViaXhr();
            await service.init();

            jasmine.clock().tick(31 * 60 * 1000);
            // Another tab rolled 5 minutes ago: live from "now", even though this
            // tab's own in-memory timestamp (still MOCK_TIMESTAMP) is 31 min stale.
            mockLocalStorage['ga_session_id'] = 'S2';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP + 26 * 60 * 1000);
            mockLocalStorage['ga_session_number'] = '4';

            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_id).toBe('S2');
            expect(req.request.body.events[0].params.session_number).toBe(4);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('attributes the engagement event to the last tracked page', async () => {
            reconfigureTestBed({ siteUrl: 'https://example.com' });
            observeFlushViaXhr();
            await service.init();
            service.trackPageView('/pricing');
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            jasmine.clock().tick(5000);
            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.page_location).toBe('https://example.com/pricing');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        // lastPagePath used to default to '/', so with siteUrl configured and no
        // router-driven page_view — an extension popup, a non-routed app,
        // initialNavigation: 'disabled' — every hide-time event was attributed to
        // siteUrl + '/', a page nobody actually visited. It now starts null and
        // falls back to window.location.href instead, the same as the no-siteUrl path.
        it('falls back to window.location.href when no page_view has fired yet, even with siteUrl configured', async () => {
            reconfigureTestBed({ siteUrl: 'https://example.com' });
            observeFlushViaXhr();
            await service.init();

            jasmine.clock().tick(5000);
            (service as any).flushEngagement();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.page_location).toBe(window.location.href);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('removes its listeners on destroy', async () => {
            await service.init();
            const documentRemove = spyOn(document, 'removeEventListener').and.callThrough();
            const windowRemove = spyOn(window, 'removeEventListener').and.callThrough();

            service.ngOnDestroy();

            expect(documentRemove).toHaveBeenCalledWith('visibilitychange', (service as any).visibilityListener);
            expect(windowRemove).toHaveBeenCalledWith('pagehide', (service as any).pagehideListener);
            expect(windowRemove).toHaveBeenCalledWith('focus', (service as any).focusListener);
            expect(windowRemove).toHaveBeenCalledWith('blur', (service as any).blurListener);
            expect(windowRemove).toHaveBeenCalledWith('pageshow', (service as any).pageshowListener);
        });

        // bfcache restore: pagehide already closed the interval on the way out.
        // pageshow is the dedicated restore signal, wired to the same handler as
        // focus, so a browser that fires pageshow but not focus/visibilitychange on
        // restore still resumes accumulation rather than reporting zero engagement
        // for the rest of the document's life — reopening depended entirely on
        // visibilitychange or focus firing before this, and neither is guaranteed on
        // every bfcache restore path.
        it('resumes accumulation on pageshow after a pagehide, without focus or visibilitychange firing', async () => {
            observeFlushViaXhr();
            await service.init();
            jasmine.clock().tick(4000);

            window.dispatchEvent(new Event('pagehide'));
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            jasmine.clock().tick(10000);   // hidden — nothing has reopened it yet

            pageEngaged = true;
            window.dispatchEvent(new Event('pageshow'));
            jasmine.clock().tick(3000);   // engaged again after the bfcache restore

            service.trackEvent('after_pageshow');
            expect(sentParams()['engagement_time_msec']).toBe(3000);
        });

        // The headline documented behaviour ("a flush extends the session") had no
        // spec proving it directly — every other flush spec asserts on the outgoing
        // event, not on the session-freshness side effect. ga_last_activity moving
        // forward is exactly what keeps a tab that is merely alt-tabbed between
        // (never closed, never hit) from expiring after 30 minutes.
        it('extends the session by writing a newer ga_last_activity on flush', async () => {
            observeFlushViaXhr();
            await service.init();
            const activityAtInit = Number(mockLocalStorage['ga_last_activity']);

            jasmine.clock().tick(5000);
            (service as any).flushEngagement();

            expect(Number(mockLocalStorage['ga_last_activity'])).toBeGreaterThan(activityAtInit);

            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });
        });
    });

    // monotonicNow() is stubbed to Date.now() in every other spec (see the
    // comment in configureTestBed) so jasmine.clock().tick() can drive it — the
    // real performance.now() path, including the Math.round() that keeps
    // engagement_time_msec an integer, otherwise has zero coverage anywhere.
    describe('monotonicNow() (real implementation)', () => {
        it('returns a non-negative integer from the real clock', () => {
            (service as any).monotonicNow.and.callThrough();

            const value = (service as any).monotonicNow();

            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
        });
    });

    // isPageEngaged() is stubbed wholesale everywhere else in this suite (see the
    // pageEngaged comment in configureTestBed) because headless Chrome always
    // reports document.hasFocus() === false, which would otherwise start every
    // timer disengaged. That leaves the real predicate with zero coverage
    // anywhere else, so it is exercised here directly — via callThrough(), which
    // restores the spy's original implementation — against a fake document.
    describe('isPageEngaged() (real implementation)', () => {
        function fakeDocument(overrides: { visibilityState?: string; hasFocus?: () => boolean }): Document {
            return {
                visibilityState: overrides.visibilityState ?? 'visible',
                ...(overrides.hasFocus ? { hasFocus: overrides.hasFocus } : {})
            } as unknown as Document;
        }

        beforeEach(() => {
            (service as any).isPageEngaged.and.callThrough();
        });

        it('is engaged when visible and focused', () => {
            spyOn(service as any, 'getDocument').and.returnValue(
                fakeDocument({ visibilityState: 'visible', hasFocus: () => true })
            );

            expect((service as any).isPageEngaged()).toBe(true);
        });

        it('is not engaged when visible but unfocused', () => {
            spyOn(service as any, 'getDocument').and.returnValue(
                fakeDocument({ visibilityState: 'visible', hasFocus: () => false })
            );

            expect((service as any).isPageEngaged()).toBe(false);
        });

        it('is not engaged when hidden, even if focused', () => {
            spyOn(service as any, 'getDocument').and.returnValue(
                fakeDocument({ visibilityState: 'hidden', hasFocus: () => true })
            );

            expect((service as any).isPageEngaged()).toBe(false);
        });

        it('assumes engaged when hasFocus is unavailable', () => {
            spyOn(service as any, 'getDocument').and.returnValue(
                fakeDocument({ visibilityState: 'visible' })
            );

            expect((service as any).isPageEngaged()).toBe(true);
        });

        // Inverted from the old expectation: starting "engaged" with no document
        // meant nothing could ever close the span (registerEngagementListeners()
        // bails out in exactly this case, so no listener would ever fire
        // setEngaged(false)) — one measured case reached pending() === 300000 after
        // five idle minutes. Without a document there is no signal that could ever
        // end the span, so this must read as not engaged.
        it('is not engaged when getDocument() returns undefined', () => {
            spyOn(service as any, 'getDocument').and.returnValue(undefined);

            expect((service as any).isPageEngaged()).toBe(false);
        });
    });

    // --- cross-tab session state ---

    describe('cross-tab session state', () => {
        // Bracket notation throughout: the repo's tsconfig sets
        // noPropertyAccessFromIndexSignature, so dot access on a Record<string, any>
        // is a compile error, not a style preference.
        function sentParams(): Record<string, any> {
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const params = req.request.body.events[0].params;
            req.flush('', { status: 204, statusText: 'No Content' });
            return params;
        }

        // The interleaving from #16: two tabs start together, one rolls, and the
        // other must adopt rather than keep sending the session it started with.
        it('adopts a session another tab rolled', async () => {
            mockLocalStorage['ga_session_id'] = 'S1';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP);
            mockLocalStorage['ga_session_number'] = '3';
            await service.init();

            // Another tab rolls: newer activity, new id, incremented number.
            jasmine.clock().tick(60000);
            mockLocalStorage['ga_session_id'] = 'S2';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP + 60000);
            mockLocalStorage['ga_session_number'] = '4';

            service.trackEvent('tab_a_event');

            const params = sentParams();
            expect(params['session_id']).toBe('S2');
            expect(params['session_number']).toBe(4);
        });

        // Equal timestamp, different id: the only seeding that discriminates `>`
        // from `>=`. An older timestamp fails both comparisons, so it would pass
        // whichever operator adoption used.
        it('keeps its own session when storage is not newer', async () => {
            mockLocalStorage['ga_session_id'] = 'S1';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP);
            mockLocalStorage['ga_session_number'] = '3';
            await service.init();

            mockLocalStorage['ga_session_id'] = 'S_EQUAL';

            service.trackEvent('same_tab');

            expect(sentParams()['session_id']).toBe('S1');
        });

        // The roll must take the number from storage, not from the value read at
        // init(): otherwise two tabs increment independently and diverge forever.
        it('increments the session number from storage when rolling', async () => {
            mockLocalStorage['ga_session_id'] = 'S1';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP);
            mockLocalStorage['ga_session_number'] = '3';
            await service.init();

            // Another tab advanced the number, then everyone went idle past the timeout.
            mockLocalStorage['ga_session_number'] = '7';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP + 1000);
            jasmine.clock().tick(31 * 60 * 1000);

            service.trackEvent('after_idle');

            expect(sentParams()['session_number']).toBe(8);
        });

        // session_number is monotonically non-decreasing for a client id. A cleared
        // ga_session_number (plausible: it's written only on a roll, while
        // ga_session_id/ga_last_activity are written on every hit) must not clobber
        // a known-good in-memory count down to 0 — parseIntSafe(undefined) is 0, and
        // 0 is not a valid GA4 session ordinal.
        it('does not drop the session number when storage has no ga_session_number', async () => {
            mockLocalStorage['ga_session_id'] = 'S1';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP);
            mockLocalStorage['ga_session_number'] = '3';
            await service.init();

            jasmine.clock().tick(60000);
            mockLocalStorage['ga_session_id'] = 'S2';
            mockLocalStorage['ga_last_activity'] = String(MOCK_TIMESTAMP + 60000);
            delete mockLocalStorage['ga_session_number'];

            service.trackEvent('after_number_cleared');

            expect(sentParams()['session_number']).toBe(3);
        });

        it('adopts session changes pushed by chrome.storage.onChanged', async () => {
            reconfigureTestBed({ isExtension: true });
            const listeners: Array<(changes: any, area: string) => void> = [];
            setupChromeMock(
                { ga_client_id: 'ext-id', ga_session_number: '3' },
                { ga_session_id: 'S1', ga_last_activity: String(MOCK_TIMESTAMP) }
            );
            (window as any).chrome.storage.onChanged = {
                addListener: (fn: any) => listeners.push(fn),
                removeListener: (fn: any) => {
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                }
            };

            await service.init();

            jasmine.clock().tick(60000);
            listeners.forEach(fn => fn({
                ga_session_id: { newValue: 'S2' },
                ga_last_activity: { newValue: String(MOCK_TIMESTAMP + 60000) }
            }, 'session'));
            listeners.forEach(fn => fn({ ga_session_number: { newValue: '4' } }, 'local'));

            service.trackEvent('ext_event');

            const params = sentParams();
            expect(params['session_id']).toBe('S2');
            expect(params['session_number']).toBe(4);
        });

        // Chrome only reports keys whose value actually changed, so a push can carry
        // ga_session_id alone, with no ga_last_activity at all. Adopting the id on no
        // freshness signal would also let two contexts rolling within the same second
        // each adopt the other's id (millisecond-distinct ids, no ordering between
        // them) — both fields must be gated on the same signal.
        it('does not adopt a pushed session id with no accompanying activity change', async () => {
            reconfigureTestBed({ isExtension: true });
            const listeners: Array<(changes: any, area: string) => void> = [];
            setupChromeMock(
                { ga_client_id: 'ext-id', ga_session_number: '3' },
                { ga_session_id: 'S1', ga_last_activity: String(MOCK_TIMESTAMP) }
            );
            (window as any).chrome.storage.onChanged = {
                addListener: (fn: any) => listeners.push(fn),
                removeListener: (fn: any) => {
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                }
            };

            await service.init();

            listeners.forEach(fn => fn({ ga_session_id: { newValue: 'S_STALE' } }, 'session'));

            service.trackEvent('ext_event');

            expect(sentParams()['session_id']).toBe('S1');
        });

        it('removes the chrome.storage.onChanged listener on destroy', async () => {
            reconfigureTestBed({ isExtension: true });
            const listeners: Array<any> = [];
            setupChromeMock({ ga_client_id: 'ext-id' }, {});
            (window as any).chrome.storage.onChanged = {
                addListener: (fn: any) => listeners.push(fn),
                removeListener: (fn: any) => {
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                }
            };

            await service.init();
            expect(listeners.length).toBe(1);

            service.ngOnDestroy();

            expect(listeners.length).toBe(0);
        });

        // The gap catchUpSessionState() closes: init()'s own awaits
        // (loadOrCreateClientId, collectContext's getHighEntropyValues, etc.) all
        // run before registerSessionSyncListener() exists, so a session rolled by
        // another extension context during that window is never delivered —
        // chrome.storage.onChanged does not replay past changes to a listener
        // registered after the fact. Exercised by mutating the mock's backing
        // store directly (not via onChanged, which is exactly what can't cover
        // this) and invoking the catch-up path once init() has finished — the
        // same effect a mutation landing mid-await would have.
        it('catches up on a session rolled in chrome.storage during init()', async () => {
            reconfigureTestBed({ isExtension: true });
            const chromeLocal: Record<string, any> = { ga_client_id: 'ext-id', ga_session_number: '3' };
            const chromeSession: Record<string, any> = { ga_session_id: 'S1', ga_last_activity: String(MOCK_TIMESTAMP) };
            setupChromeMock(chromeLocal, chromeSession);

            await service.init();

            // Another context rolls the session while nothing was yet listening.
            chromeSession['ga_session_id'] = 'S2';
            chromeSession['ga_last_activity'] = String(MOCK_TIMESTAMP + 60000);
            chromeLocal['ga_session_number'] = '4';

            await (service as any).catchUpSessionState();

            service.trackEvent('after_catch_up');
            const params = sentParams();
            expect(params['session_id']).toBe('S2');
            expect(params['session_number']).toBe(4);
        });

        // adoptSessionNumber()'s own monotonic guard applies during catch-up just
        // as it does for registerSessionSyncListener's 'local' branch: session
        // numbers only ever count up, so a stale or corrupted read must not
        // clobber a known-good in-memory value.
        it('does not lower the session number during catch-up', async () => {
            reconfigureTestBed({ isExtension: true });
            const chromeLocal: Record<string, any> = { ga_client_id: 'ext-id', ga_session_number: '3' };
            const chromeSession: Record<string, any> = { ga_session_id: 'S1', ga_last_activity: String(MOCK_TIMESTAMP) };
            setupChromeMock(chromeLocal, chromeSession);

            await service.init();

            chromeLocal['ga_session_number'] = '1';

            await (service as any).catchUpSessionState();

            service.trackEvent('after_catch_up');
            expect(sentParams()['session_number']).toBe(3);
        });

        // Every spec above hand-seeds mockLocalStorage to stand in for "another
        // tab". This one builds a second, independently constructed NgGa4Service
        // over the same mocked localStorage and lets it roll its own session for
        // real, exercising the actual adoption mechanism two real tabs rely on
        // rather than a stand-in for it.
        it('adopts a session rolled by a second, real NgGa4Service instance sharing storage', async () => {
            await service.init();

            const second = Injector.create({
                providers: [
                    NgGa4Service,
                    // Shares this spec's HttpClient (and therefore httpMock) rather than
                    // standing up a second one — there is only one network to assert on.
                    { provide: HttpClient, useValue: TestBed.inject(HttpClient) },
                    { provide: Router, useValue: { events: new Subject<any>().asObservable() } },
                    // 'storage' skips the _ga cookie entirely: this second instance has
                    // no getCookieJar/setCookie spies of its own (those are only wired
                    // onto `service` in configureTestBed), so touching the real
                    // document.cookie here would leak between specs.
                    { provide: NG_GA4_CONFIG, useValue: { ...defaultConfig, clientIdSource: 'storage' } },
                    { provide: PLATFORM_ID, useValue: 'browser' },
                    { provide: NgZone, useValue: TestBed.inject(NgZone) }
                ]
            }).get(NgGa4Service);

            await second.init();
            // Both instances now hold the same session read from shared storage.
            // Advance past the timeout so second's own roll, below, is a real one.
            jasmine.clock().tick(31 * 60 * 1000);
            second.trackEvent('tab_b_rolls');
            httpMock.expectOne((r) => r.url.includes('mp/collect'))
                .flush('', { status: 204, statusText: 'No Content' });

            service.trackEvent('tab_a_after_roll');
            const params = sentParams();
            expect(params['session_id']).toBe((second as any).sessionId);
            expect(params['session_number']).toBe((second as any).sessionNumber);

            // Cleanup: `second` registered its own visibilitychange/focus/blur/
            // pageshow/pagehide listeners on the real document/window (unlike
            // `service`, it isn't destroyed by the top-level afterEach), which would
            // otherwise leak into later specs the same way the afterEach comment
            // above warns about for `service`.
            second.ngOnDestroy();
        });
    });

    // --- writeGaCookie options ---

    describe('writeGaCookie options', () => {
        it('writes with an explicit domain and issues no probe cookie', async () => {
            reconfigureTestBed({ writeGaCookie: { domain: '.example.com' } });
            spyOn(service as any, 'getHostname').and.returnValue('www.example.com');

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toContain('domain=.example.com');
            // Discovery is bypassed entirely — no throwaway probe cookie at all.
            expect(writtenCookies.some(c => c.includes('_ng_ga4_probe_'))).toBe(false);
        });

        it('emits a custom max-age', async () => {
            reconfigureTestBed({ writeGaCookie: { maxAgeSeconds: 60 } });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');

            await service.init();

            expect(writtenCookies.find(c => c.startsWith('_ga='))).toContain('max-age=60');
        });

        it('emits custom flags in place of the default SameSite=Lax', async () => {
            reconfigureTestBed({ writeGaCookie: { flags: 'SameSite=None; Secure' } });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toContain('SameSite=None; Secure');
            expect(gaCookie).not.toContain('SameSite=Lax');
        });

        it('adds Secure to the default flags on HTTPS', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');
            spyOn(service as any, 'getProtocol').and.returnValue('https:');

            await service.init();

            expect(writtenCookies.find(c => c.startsWith('_ga=')))
                .toContain('SameSite=Lax; Secure');
        });

        it('omits Secure from the default flags on HTTP', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');
            spyOn(service as any, 'getProtocol').and.returnValue('http:');

            await service.init();

            expect(writtenCookies.find(c => c.startsWith('_ga='))).not.toContain('Secure');
        });

        // A host-only _ga diverges per subdomain and can shadow a correctly-scoped
        // one already in the jar, so it must not be written as a "better than
        // nothing" fallback once every candidate domain has been refused.
        it('writes no _ga at all when every candidate domain is refused', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            spyOn(service as any, 'getHostname').and.returnValue('www.example.com');
            cookieAcceptsDomain = () => false;

            await service.init();

            expect(writtenCookies.filter(c => c.startsWith('_ga='))).toEqual([]);
        });

        // A single-label host has no candidates to refuse in the first place — that
        // is "nothing to try", not "everything refused", so it must still write.
        it('still writes a host-only _ga on a single-label host', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');

            await service.init();

            const gaCookie = writtenCookies.find(c => c.startsWith('_ga='));
            expect(gaCookie).toBeDefined();
            expect(gaCookie).not.toContain('domain=');
        });

        it('writes with every default when given an empty options object', async () => {
            reconfigureTestBed({ writeGaCookie: {} });
            spyOn(service as any, 'getHostname').and.returnValue('localhost');

            await service.init();

            expect(writtenCookies.find(c => c.startsWith('_ga=')))
                .toContain('max-age=63072000');
        });
    });

    // --- server-side rendering ---

    describe('server platform', () => {
        it('should not touch storage or the network when init() runs on the server', async () => {
            reconfigureTestBed({}, 'server');

            await service.init();

            expect(localStorage.getItem).not.toHaveBeenCalled();
            expect(localStorage.setItem).not.toHaveBeenCalled();
            expect(crypto.randomUUID).not.toHaveBeenCalled();
            expect(writtenCookies).toEqual([]);
            httpMock.expectNone(() => true);
            expect((service as any).visibilityListener).toBeUndefined();
            expect((service as any).chromeStorageListener).toBeUndefined();
        });

        it('should no-op trackEvent and trackPageView on the server', async () => {
            reconfigureTestBed({}, 'server');
            await service.init();

            service.trackPageView('/ssr');
            service.trackEvent('ssr_event');

            httpMock.expectNone(() => true);
        });

        it('should not subscribe to router navigation on the server', async () => {
            reconfigureTestBed({}, 'server');
            await service.init();

            routerEvents$.next(new NavigationEnd(1, '/ssr', '/ssr'));

            httpMock.expectNone(() => true);
        });
    });

    // --- trackPageView() ---

    describe('trackPageView()', () => {
        beforeEach(async () => {
            await service.init();
        });

        it('should POST page_view event with window.location.href', () => {
            service.trackPageView('/home');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_view');
            expect(req.request.body.events[0].params.page_location).toBe(window.location.href);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should POST page_view event with siteUrl + path when siteUrl configured', async () => {
            reconfigureTestBed({ siteUrl: 'https://example.com' });

            await service.init();
            service.trackPageView('/dashboard');
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.page_location).toBe('https://example.com/dashboard');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should normalize trailing slash on siteUrl and missing leading slash on path', async () => {
            reconfigureTestBed({ siteUrl: 'https://example.com/' });

            await service.init();
            service.trackPageView('dashboard');
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.page_location).toBe('https://example.com/dashboard');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should redact api_secret from console.error payload on HTTP failure', async () => {
            spyOn(console, 'error');

            service.trackPageView('/test');
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            req.error(new ProgressEvent('network error'), { status: 500, statusText: 'Server Error' });

            expect(console.error).toHaveBeenCalled();
            const logged = (console.error as jasmine.Spy).calls.mostRecent().args;
            const serialized = JSON.stringify(logged);
            expect(serialized).not.toContain('test-secret');
            expect(serialized).toContain('api_secret=***');
        });

        it('should include measurement_id and api_secret in URL', () => {
            service.trackPageView('/test');
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.url).toContain('measurement_id=G-TEST123');
            expect(req.request.url).toContain('api_secret=test-secret');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should not track when disabled', () => {
            reconfigureTestBed({ enabled: false });

            service.trackPageView('/test');
            httpMock.expectNone(() => true);
        });

        it('should not track when not initialized', () => {
            reconfigureTestBed();

            // Don't call init()
            service.trackPageView('/test');
            httpMock.expectNone(() => true);
        });
    });

    // --- trackEvent() ---

    describe('trackEvent()', () => {
        beforeEach(async () => {
            await service.init();
        });

        it('should POST custom event', () => {
            service.trackEvent('button_click');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('button_click');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should include custom params', () => {
            service.trackEvent('file_download', { file_name: 'test.pdf', file_size: 1024 });

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const params = req.request.body.events[0].params;
            expect(params.file_name).toBe('test.pdf');
            expect(params.file_size).toBe(1024);
            expect(params.session_id).toBeDefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should not track when disabled', () => {
            reconfigureTestBed({ enabled: false });

            service.trackEvent('test_event');
            httpMock.expectNone(() => true);
        });
    });

    // --- session management ---

    describe('session management', () => {
        it('should start session_number at 1', async () => {
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_number).toBe(1);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should have session_id as numeric string', async () => {
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const sessionId = req.request.body.events[0].params.session_id;
            expect(sessionId).toBe(MOCK_SESSION_ID);
            expect(parseInt(sessionId, 10).toString()).toBe(sessionId);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should keep same session within 30 minutes', async () => {
            await service.init();
            service.trackPageView('/page1');

            const req1 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const sessionId1 = req1.request.body.events[0].params.session_id;
            req1.flush('', { status: 204, statusText: 'No Content' });

            // Advance 20 minutes
            jasmine.clock().tick(20 * 60 * 1000);
            service.trackPageView('/page2');

            const req2 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req2.request.body.events[0].params.session_id).toBe(sessionId1);
            req2.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should rotate session after 30 minutes of inactivity', async () => {
            await service.init();
            service.trackPageView('/page1');

            const req1 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const sessionId1 = req1.request.body.events[0].params.session_id;
            req1.flush('', { status: 204, statusText: 'No Content' });

            // Advance 31 minutes
            jasmine.clock().tick(31 * 60 * 1000);
            service.trackPageView('/page2');

            const req2 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const sessionId2 = req2.request.body.events[0].params.session_id;
            expect(sessionId2).not.toBe(sessionId1);
            req2.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should increment session_number on new session', async () => {
            await service.init();
            service.trackPageView('/page1');

            const req1 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req1.request.body.events[0].params.session_number).toBe(1);
            req1.flush('', { status: 204, statusText: 'No Content' });

            // Advance past timeout
            jasmine.clock().tick(31 * 60 * 1000);
            service.trackPageView('/page2');

            const req2 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req2.request.body.events[0].params.session_number).toBe(2);
            req2.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should persist session state to localStorage', async () => {
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            req.flush('', { status: 204, statusText: 'No Content' });

            expect(localStorage.setItem).toHaveBeenCalledWith('ga_session_id', jasmine.any(String));
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_last_activity', jasmine.any(String));
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_session_number', '1');
        });

        it('should restore session from localStorage within timeout', async () => {
            const pastTimestamp = MOCK_TIMESTAMP - 10 * 60 * 1000; // 10 min ago
            mockLocalStorage['ga_session_id'] = 'restored-session';
            mockLocalStorage['ga_last_activity'] = pastTimestamp.toString();
            mockLocalStorage['ga_session_number'] = '5';

            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_id).toBe('restored-session');
            expect(req.request.body.events[0].params.session_number).toBe(5);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should start new session when stored session is past timeout', async () => {
            const pastTimestamp = MOCK_TIMESTAMP - 31 * 60 * 1000; // 31 min ago
            mockLocalStorage['ga_session_id'] = 'old-session';
            mockLocalStorage['ga_last_activity'] = pastTimestamp.toString();
            mockLocalStorage['ga_session_number'] = '3';

            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_id).not.toBe('old-session');
            expect(req.request.body.events[0].params.session_number).toBe(4);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should persist session_number in chrome.storage.local when isExtension', async () => {
            reconfigureTestBed({ isExtension: true });

            const chromeLocal: Record<string, any> = {};
            const chromeSession: Record<string, any> = {};
            setupChromeMock(chromeLocal, chromeSession);

            await service.init();
            expect(chromeLocal['ga_session_number']).toBe('1');
        });

        it('should persist session data in chrome.storage.session when isExtension', async () => {
            reconfigureTestBed({ isExtension: true });

            const chromeLocal: Record<string, any> = {};
            const chromeSession: Record<string, any> = {};
            setupChromeMock(chromeLocal, chromeSession);

            await service.init();
            expect(chromeSession['ga_session_id']).toBeDefined();
            expect(chromeSession['ga_last_activity']).toBeDefined();
        });
    });

    // --- debug mode ---

    describe('debug mode', () => {
        // The validation endpoint does not record anything ("events sent to the
        // validation server don't show up in reports"), so debug mode must still
        // send the real hit to production and use validation only as a side channel.
        function expectDebugPair(): { real: TestRequest; validation: TestRequest } {
            const all = httpMock.match((r) => r.url.includes('mp/collect'));
            const real = all.find((r) => !r.request.url.includes('debug/mp/collect'))!;
            const validation = all.find((r) => r.request.url.includes('debug/mp/collect'))!;
            return { real, validation };
        }

        it('should still send the real hit to the production endpoint when debug is true', async () => {
            reconfigureTestBed({ debug: true });

            await service.init();
            service.trackPageView('/test');

            const { real, validation } = expectDebugPair();
            expect(real).toBeDefined();
            expect(real.request.url).not.toContain('debug/mp/collect');
            real.flush('', { status: 204, statusText: 'No Content' });
            validation.flush({ validationMessages: [] });
        });

        it('should tag every event with debug_mode so it surfaces in DebugView', async () => {
            reconfigureTestBed({ debug: true });

            await service.init();
            service.trackEvent('custom_event', { foo: 'bar' });

            const { real, validation } = expectDebugPair();
            expect(real.request.body.events[0].params.debug_mode).toBe(1);
            expect(real.request.body.events[0].params.foo).toBe('bar');
            real.flush('', { status: 204, statusText: 'No Content' });
            validation.flush({ validationMessages: [] });
        });

        it('should also post the payload to the validation endpoint', async () => {
            reconfigureTestBed({ debug: true });

            await service.init();
            service.trackPageView('/test');

            const { real, validation } = expectDebugPair();
            expect(validation).toBeDefined();
            expect(validation.request.body.events[0].name).toBe('page_view');
            real.flush('', { status: 204, statusText: 'No Content' });
            validation.flush({ validationMessages: [] });
        });

        it('should warn with the messages when validation reports a problem', async () => {
            reconfigureTestBed({ debug: true });

            spyOn(console, 'warn');
            await service.init();
            service.trackPageView('/test');

            const { real, validation } = expectDebugPair();
            const messages = [{ fieldPath: 'events', description: 'bad event name' }];
            real.flush('', { status: 204, statusText: 'No Content' });
            validation.flush({ validationMessages: messages });

            expect(console.warn).toHaveBeenCalledWith('[ng-ga4] GA4 rejected this payload:', messages);
        });

        it('should not warn when validation comes back clean', async () => {
            reconfigureTestBed({ debug: true });

            spyOn(console, 'warn');
            await service.init();
            service.trackPageView('/test');

            const { real, validation } = expectDebugPair();
            real.flush('', { status: 204, statusText: 'No Content' });
            validation.flush({ validationMessages: [] });

            expect(console.warn).not.toHaveBeenCalled();
        });

        it('should send to production endpoint and omit debug_mode when debug is false', async () => {
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.url).not.toContain('debug/mp/collect');
            expect(req.request.body.events[0].params.debug_mode).toBeUndefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });
    });

    // --- storage robustness ---

    describe('storage robustness', () => {
        it('should fall back to localStorage when chrome.storage.local.get rejects', async () => {
            reconfigureTestBed({ isExtension: true });
            (window as any).chrome.storage = {
                local: {
                    get: () => Promise.reject(new Error('storage error')),
                    set: () => Promise.resolve()
                },
                session: {
                    get: () => Promise.resolve({}),
                    set: () => Promise.resolve()
                }
            };
            spyOn(console, 'warn');
            spyOn(service as any, 'randomClientIdSeed').and.returnValue(MOCK_CLIENT_ID_SEED);

            await service.init();

            // Same localStorage fallback as the direct web path, so it mints in
            // gtag's shape here too — see loadOrCreateClientIdFromLocalStorage.
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_client_id', MOCK_MINTED_CLIENT_ID);
            expect(console.warn).toHaveBeenCalled();
        });

        it('should fall back to localStorage when chrome.storage.session.get rejects', async () => {
            reconfigureTestBed({ isExtension: true });
            const chromeLocal: Record<string, any> = {};
            (window as any).chrome.storage = {
                local: {
                    get: (keys: string[]) => Promise.resolve(
                        keys.reduce((acc: any, k: string) => { if (chromeLocal[k] !== undefined) acc[k] = chromeLocal[k]; return acc; }, {})
                    ),
                    set: (items: any) => { Object.assign(chromeLocal, items); return Promise.resolve(); }
                },
                session: {
                    get: () => Promise.reject(new Error('session storage error')),
                    set: () => Promise.resolve()
                }
            };
            spyOn(console, 'warn');

            await service.init();
            service.trackPageView('/test');

            expect(console.warn).toHaveBeenCalled();
            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_id).toBe(MOCK_SESSION_ID);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should not throw when chrome.storage.local.set rejects', async () => {
            reconfigureTestBed({ isExtension: true });
            (window as any).chrome.storage = {
                local: {
                    get: () => Promise.resolve({}),
                    set: () => Promise.reject(new Error('quota exceeded'))
                },
                session: {
                    get: () => Promise.resolve({}),
                    set: () => Promise.reject(new Error('session set error'))
                }
            };
            spyOn(console, 'warn');

            await expectAsync(service.init()).toBeResolved();
        });

        it('should fall back to session_number 0 when localStorage value is non-numeric', async () => {
            mockLocalStorage['ga_session_number'] = 'corrupted';
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_number).toBe(1);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should start a new session when stored ga_last_activity is non-numeric', async () => {
            mockLocalStorage['ga_session_id'] = 'stored-session';
            mockLocalStorage['ga_last_activity'] = 'not-a-timestamp';
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].params.session_id).not.toBe('stored-session');
            req.flush('', { status: 204, statusText: 'No Content' });
        });
    });

    // --- device & location enrichment ---

    describe('device & location enrichment', () => {
        const fakeUaData = (overrides?: { mobile?: boolean; high?: any; reject?: boolean }) => ({
            mobile: overrides?.mobile ?? false,
            getHighEntropyValues: () => overrides?.reject
                ? Promise.reject(new Error('blocked'))
                : Promise.resolve(overrides?.high ?? {
                    platform: 'Windows',
                    platformVersion: '15.0.0',
                    fullVersionList: [
                        { brand: 'Chromium', version: '120.0.0.0' },
                        { brand: 'Google Chrome', version: '120.0.1.2' },
                        { brand: 'Not.A/Brand', version: '99.0.0.0' }
                    ]
                })
        });

        it('attaches request-level device built from userAgentData', async () => {
            spyOn<any>(service, 'getUserAgentData').and.returnValue(fakeUaData());

            await service.init();
            service.trackEvent('button_click');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const device = req.request.body.device;
            expect(device.category).toBe('desktop');
            expect(device.operating_system).toBe('Windows');
            expect(device.operating_system_version).toBe('15.0.0');
            expect(device.browser).toBe('Chrome');
            expect(device.browser_version).toBe('120.0.1.2');
            // device must be a sibling of client_id/events, not inside event params
            expect(req.request.body.events[0].params.device).toBeUndefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('normalizes Microsoft Edge brand and reports mobile category', async () => {
            spyOn<any>(service, 'getUserAgentData').and.returnValue(fakeUaData({
                mobile: true,
                high: {
                    platform: 'Android',
                    platformVersion: '14',
                    fullVersionList: [
                        { brand: 'Chromium', version: '120.0.0.0' },
                        { brand: 'Microsoft Edge', version: '120.0.5.6' }
                    ]
                }
            }));

            await service.init();
            service.trackEvent('x');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.device.category).toBe('mobile');
            expect(req.request.body.device.operating_system).toBe('Android');
            expect(req.request.body.device.browser).toBe('Edge');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        const SAFARI_MACOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';
        const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        it('falls back to the user-agent string when userAgentData is unavailable', async () => {
            // Safari and Firefox never implement userAgentData, so this is the path
            // most non-Chromium traffic actually takes.
            spyOn<any>(service, 'getUserAgentData').and.returnValue(undefined);
            spyOn<any>(service, 'getUserAgentString').and.returnValue(SAFARI_MACOS);

            await service.init();
            service.trackEvent('x');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const device = req.request.body.device;
            expect(device.category).toBe('desktop');
            expect(device.operating_system).toBe('macOS');
            // Frozen UA token — deliberately not reported. See ua-device.spec.ts.
            expect('operating_system_version' in device).toBe(false);
            expect(device.browser).toBe('Safari');
            expect(device.browser_version).toBe('17.4.1');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('fills the gaps from the user-agent string when high-entropy hints are blocked', async () => {
            spyOn<any>(service, 'getUserAgentData').and.returnValue(fakeUaData({ reject: true }));
            spyOn<any>(service, 'getUserAgentString').and.returnValue(CHROME_WINDOWS);

            await service.init();
            service.trackEvent('x');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const device = req.request.body.device;
            expect(device.category).toBe('desktop');
            expect(device.operating_system).toBe('Windows');
            expect(device.browser).toBe('Chrome');
            expect(device.browser_version).toBe('120.0.0.0');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('prefers userAgentData over the user-agent string when both are present', async () => {
            // Client Hints are authoritative; the UA string is only ever a gap-filler.
            spyOn<any>(service, 'getUserAgentData').and.returnValue(fakeUaData());
            spyOn<any>(service, 'getUserAgentString').and.returnValue(SAFARI_MACOS);

            await service.init();
            service.trackEvent('x');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const device = req.request.body.device;
            expect(device.operating_system).toBe('Windows');
            expect(device.operating_system_version).toBe('15.0.0');
            expect(device.browser).toBe('Chrome');
            expect(device.browser_version).toBe('120.0.1.2');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('derives user_location.country_id from the browser time zone', async () => {
            spyOn<any>(service, 'getTimeZone').and.returnValue('Europe/Berlin');

            await service.init();
            service.trackPageView('/home');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.user_location).toEqual({ country_id: 'DE' });
            expect(req.request.body.events[0].params.user_location).toBeUndefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('omits user_location when the time zone has no country mapping', async () => {
            spyOn<any>(service, 'getTimeZone').and.returnValue('UTC');
            spyOn<any>(service, 'getUserAgentData').and.returnValue(undefined);

            await service.init();
            service.trackEvent('x');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect('user_location' in req.request.body).toBe(false);
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('does not collect context when disabled', async () => {
            reconfigureTestBed({ enabled: false });
            const spy = spyOn<any>(service, 'getUserAgentData').and.returnValue(fakeUaData());

            await service.init();

            expect(spy).not.toHaveBeenCalled();
            httpMock.expectNone(() => true);
        });
    });

    // --- queue during init() ---

    describe('event queue during init()', () => {
        async function flushMicrotasks(times = 20): Promise<void> {
            for (let i = 0; i < times; i++) {
                await Promise.resolve();
            }
        }

        it('queues trackEvent fired during init() and flushes after clientId is assigned', async () => {
            let resolveContext!: () => void;
            const contextDeferred = new Promise<void>(r => { resolveContext = r; });
            spyOn<any>(service, 'collectContext').and.returnValue(contextDeferred);

            const initPromise = service.init();
            await flushMicrotasks();

            // clientId is not yet assigned — init() is suspended on collectContext.
            service.trackEvent('extension_installed', { version: '1.4.0' });

            // Nothing sent yet (queued, not dropped).
            httpMock.expectNone(() => true);

            resolveContext();
            await initPromise;
            await flushMicrotasks();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('extension_installed');
            expect(req.request.body.events[0].params.version).toBe('1.4.0');
            expect(req.request.body.client_id).toBeDefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('queues trackPageView fired during init() and flushes after clientId is assigned', async () => {
            let resolveContext!: () => void;
            const contextDeferred = new Promise<void>(r => { resolveContext = r; });
            spyOn<any>(service, 'collectContext').and.returnValue(contextDeferred);

            const initPromise = service.init();
            await flushMicrotasks();

            service.trackPageView('/welcome');
            httpMock.expectNone(() => true);

            resolveContext();
            await initPromise;
            await flushMicrotasks();

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_view');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('flushes multiple queued events in FIFO order', async () => {
            let resolveContext!: () => void;
            const contextDeferred = new Promise<void>(r => { resolveContext = r; });
            spyOn<any>(service, 'collectContext').and.returnValue(contextDeferred);

            const initPromise = service.init();
            await flushMicrotasks();

            service.trackEvent('first');
            service.trackEvent('second');
            service.trackEvent('third');

            resolveContext();
            await initPromise;
            await flushMicrotasks();

            const reqs = httpMock.match((r) => r.url.includes('mp/collect'));
            expect(reqs.length).toBe(3);
            expect(reqs[0].request.body.events[0].name).toBe('first');
            expect(reqs[1].request.body.events[0].name).toBe('second');
            expect(reqs[2].request.body.events[0].name).toBe('third');
            reqs.forEach(r => r.flush('', { status: 204, statusText: 'No Content' }));
        });

        it('does not queue when service is disabled', async () => {
            reconfigureTestBed({ enabled: false });

            service.trackEvent('should_be_dropped');
            await service.init();

            httpMock.expectNone(() => true);
        });
    });

    // --- router integration ---

    describe('router integration', () => {
        it('should track page view on NavigationEnd', async () => {
            await service.init();
            routerEvents$.next(new NavigationEnd(1, '/test', '/test'));

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('page_view');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should ignore NavigationStart', async () => {
            await service.init();
            routerEvents$.next(new NavigationStart(1, '/test'));

            httpMock.expectNone(() => true);
        });
    });

    // --- app_version stamping ---

    describe('app_version stamping', () => {
        it('should stamp app_version on trackEvent when config.appVersion is set', async () => {
            reconfigureTestBed({ appVersion: '1.0.4' });
            await service.init();

            service.trackEvent('button_click', { x: 1 });

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const params = req.request.body.events[0].params;
            expect(params.app_version).toBe('1.0.4');
            expect(params.x).toBe(1);
            expect(params.session_id).toBeDefined();
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should stamp app_version on trackPageView when config.appVersion is set', async () => {
            reconfigureTestBed({ appVersion: '1.0.4' });
            await service.init();

            service.trackPageView('/dashboard');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const params = req.request.body.events[0].params;
            expect(params.app_version).toBe('1.0.4');
            expect(req.request.body.events[0].name).toBe('page_view');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should omit app_version when config.appVersion is undefined', async () => {
            reconfigureTestBed({});
            await service.init();

            service.trackEvent('button_click', { x: 1 });

            const req1 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req1.request.body.events[0].params.app_version).toBeUndefined();
            expect('app_version' in req1.request.body.events[0].params).toBe(false);
            req1.flush('', { status: 204, statusText: 'No Content' });

            service.trackPageView('/home');
            const req2 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect('app_version' in req2.request.body.events[0].params).toBe(false);
            req2.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should omit app_version when config.appVersion is an empty string', async () => {
            reconfigureTestBed({ appVersion: '' });
            await service.init();

            service.trackEvent('button_click');

            const req1 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect('app_version' in req1.request.body.events[0].params).toBe(false);
            req1.flush('', { status: 204, statusText: 'No Content' });

            service.trackPageView('/home');
            const req2 = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect('app_version' in req2.request.body.events[0].params).toBe(false);
            req2.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should override caller-supplied app_version with config value', async () => {
            reconfigureTestBed({ appVersion: '1.0.4' });
            await service.init();

            service.trackEvent('s3_connection_create', { app_version: 'spoofed', connection_type: 'S3' });

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const params = req.request.body.events[0].params;
            expect(params.app_version).toBe('1.0.4');
            expect(params.connection_type).toBe('S3');
            req.flush('', { status: 204, statusText: 'No Content' });
        });
    });

    // --- beacon transport (production default) ---
    //
    // The production-default transport is navigator.sendBeacon (with a fetch-keepalive
    // and XHR fallback chain) so events fired right before the page/tab unloads are not
    // dropped — an XHR in flight is aborted on unload, sendBeacon is not.

    describe('beacon transport (production default)', () => {
        let beaconCalls: Array<{ url: string; body: Blob }>;
        let beaconSpy: jasmine.Spy;
        let fetchSpy: jasmine.Spy;

        function installBeacon(returnValue = true): void {
            beaconCalls = [];
            beaconSpy = jasmine.createSpy('sendBeacon').and.callFake((url: string, body: Blob) => {
                beaconCalls.push({ url, body });
                return returnValue;
            });
            spyOn<any>(service, 'getNavigator').and.returnValue({ sendBeacon: beaconSpy });
        }

        async function beaconBody(index = 0): Promise<any> {
            return JSON.parse(await beaconCalls[index].body.text());
        }

        function installFetch(): void {
            fetchSpy = jasmine.createSpy('fetch').and.returnValue(Promise.resolve());
            spyOn<any>(service, 'getFetch').and.returnValue(fetchSpy);
        }

        it('sends production hits via navigator.sendBeacon instead of XHR', async () => {
            reconfigureTestBed({ transport: 'beacon' });
            installBeacon();

            await service.init();
            service.trackEvent('extension_installed', { version: '1.4.0' });

            // No XHR was made — afterEach httpMock.verify() also enforces this.
            httpMock.expectNone(() => true);
            expect(beaconCalls.length).toBe(1);
            expect(beaconCalls[0].url).toContain('mp/collect');
            expect(beaconCalls[0].url).not.toContain('debug/mp/collect');
            // GA4 /mp/collect expects application/json — a text/plain body is silently dropped.
            expect(beaconCalls[0].body.type).toBe('application/json');

            const body = await beaconBody();
            expect(body.events[0].name).toBe('extension_installed');
            expect(body.events[0].params.version).toBe('1.4.0');
            expect(body.client_id).toBeDefined();
        });

        it('is the transport when none is configured (beacon is the default)', async () => {
            reconfigureTestBed({ transport: undefined });
            installBeacon();

            await service.init();
            service.trackPageView('/home');

            httpMock.expectNone(() => true);
            expect(beaconCalls.length).toBe(1);
            expect((await beaconBody()).events[0].name).toBe('page_view');
        });

        it('falls back to fetch(keepalive) when sendBeacon reports the hit was not queued', async () => {
            reconfigureTestBed({ transport: 'beacon' });
            installBeacon(false);
            installFetch();

            await service.init();
            service.trackEvent('file_download');

            httpMock.expectNone(() => true);
            expect(beaconSpy).toHaveBeenCalled();
            expect(fetchSpy).toHaveBeenCalled();
            const [url, init] = fetchSpy.calls.mostRecent().args;
            expect(url).toContain('mp/collect');
            expect(init.method).toBe('POST');
            expect(init.keepalive).toBe(true);
            expect(init.headers['Content-Type']).toBe('application/json');
            expect(JSON.parse(init.body).events[0].name).toBe('file_download');
        });

        it('falls back to fetch(keepalive) when sendBeacon throws synchronously', async () => {
            reconfigureTestBed({ transport: 'beacon' });
            const throwingBeacon = jasmine.createSpy('sendBeacon').and.throwError('SecurityError');
            spyOn<any>(service, 'getNavigator').and.returnValue({ sendBeacon: throwingBeacon });
            installFetch();

            await service.init();
            service.trackEvent('file_copy_move');

            httpMock.expectNone(() => true);
            expect(throwingBeacon).toHaveBeenCalled();
            expect(fetchSpy).toHaveBeenCalled();
        });

        it('falls back to fetch(keepalive) when sendBeacon is unavailable', async () => {
            reconfigureTestBed({ transport: 'beacon' });
            spyOn<any>(service, 'getNavigator').and.returnValue({});
            installFetch();

            await service.init();
            service.trackEvent('file_upload');

            httpMock.expectNone(() => true);
            expect(fetchSpy).toHaveBeenCalled();
        });

        it('falls back to XHR when neither sendBeacon nor fetch are available', async () => {
            reconfigureTestBed({ transport: 'beacon' });
            spyOn<any>(service, 'getNavigator').and.returnValue({});
            spyOn<any>(service, 'getFetch').and.returnValue(undefined);

            await service.init();
            service.trackEvent('file_delete');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.body.events[0].name).toBe('file_delete');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('still sends the real hit over the beacon in debug mode, validating alongside it', async () => {
            reconfigureTestBed({ transport: 'beacon', debug: true });
            installBeacon();

            await service.init();
            service.trackEvent('x');

            // The recorded hit goes out on the configured transport, so debug mode
            // exercises the same delivery path production will.
            expect(beaconCalls.length).toBe(1);
            expect(beaconCalls[0].url).not.toContain('debug/mp/collect');
            const body = await beaconBody();
            expect(body.events[0].params.debug_mode).toBe(1);

            // Validation is a separate XHR side channel, not a replacement.
            const req = httpMock.expectOne((r) => r.url.includes('debug/mp/collect'));
            req.flush({ validationMessages: [] });
        });
    });

    describe('consent', () => {
        it('omits the consent key entirely by default', async () => {
            await service.init();
            service.trackEvent('test_event');

            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            // Byte-identical to pre-consent versions: an existing install that never
            // calls setConsent() must send exactly what it sent before.
            expect(req.request.body['consent']).toBeUndefined();
            req.flush({});
        });

        it('sends ad signals supplied via config', async () => {
            reconfigureTestBed({ consent: { adUserData: 'granted', adPersonalization: 'denied' } });
            await service.init();
            service.trackEvent('test_event');

            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(req.request.body['consent']).toEqual({ ad_user_data: 'GRANTED', ad_personalization: 'DENIED' });
            req.flush({});
        });

        it('reflects a runtime setConsent() call on the next hit', async () => {
            await service.init();
            service.setConsent({ adUserData: 'denied' });
            service.trackEvent('test_event');

            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(req.request.body['consent']).toEqual({ ad_user_data: 'DENIED' });
            req.flush({});
        });

        it('does not initialise or mint an identifier while disabled', async () => {
            reconfigureTestBed({ enabled: false });
            await service.init();

            expect(mockLocalStorage['ga_client_id']).toBeUndefined();
            httpMock.expectNone(() => true);
        });

        it('starts collecting after setEnabled(true)', async () => {
            reconfigureTestBed({ enabled: false });
            await service.init();

            service.setEnabled(true);
            // Awaits the in-flight init started by setEnabled, not a fresh one —
            // this only works because init() memoises its promise.
            await service.init();
            service.trackEvent('after_consent');

            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(req.request.body['events'][0]['name']).toBe('after_consent');
            req.flush({});
        });

        it('drops events fired while disabled instead of replaying them on enable', async () => {
            reconfigureTestBed({ enabled: false });
            await service.init();
            service.trackEvent('lost_event');

            service.setEnabled(true);
            await service.init();
            service.trackEvent('after_consent');

            // Anchored positively: exactly one request, and it is the post-consent
            // one. A bare expectNone would pass even if the drop logic were deleted.
            const reqs = httpMock.match(() => true);
            expect(reqs.length).toBe(1);
            expect(reqs[0].request.body['events'][0]['name']).toBe('after_consent');
            reqs[0].flush({});
        });

        it('stops sending after setEnabled(false) without deleting the identifier', async () => {
            await service.init();
            const stored = mockLocalStorage['ga_client_id'];
            expect(stored).toBeDefined();

            service.setEnabled(false);
            service.trackEvent('ignored');

            httpMock.expectNone(() => true);
            // setEnabled is a kill switch, not a consent withdrawal.
            expect(mockLocalStorage['ga_client_id']).toBe(stored);
        });

        it('does not flush engagement on hide after setEnabled(false)', async () => {
            await service.init();
            service.trackPageView('/page');
            httpMock.expectOne(r => r.url.includes('/mp/collect')).flush({});

            service.setEnabled(false);
            jasmine.clock().tick(5000);
            // forceBeacon would otherwise bypass HttpTestingController entirely.
            (service as any).getNavigator = () => ({});
            (service as any).getFetch = () => undefined;
            window.dispatchEvent(new Event('pagehide'));

            httpMock.expectNone(() => true);
        });

        it('does not cache a rejected init, so a later call can retry', async () => {
            let failing = true;
            (localStorage.setItem as jasmine.Spy).and.callFake((key: string, value: string) => {
                if (failing && key === 'ga_client_id') {
                    throw new Error('QuotaExceededError');
                }
                mockLocalStorage[key] = value;
            });

            await expectAsync(service.init()).toBeRejected();

            failing = false;
            await service.init();

            // A transient storage failure (Safari private browsing, quota) must not
            // poison the service for the rest of its lifetime.
            expect(mockLocalStorage['ga_client_id']).toBeDefined();
        });

        it('does not re-register listeners when a failed init is retried', async () => {
            const addSpy = spyOn(document, 'addEventListener').and.callThrough();
            let failing = true;
            (localStorage.setItem as jasmine.Spy).and.callFake((key: string, value: string) => {
                if (failing && key === 'ga_client_id') {
                    throw new Error('QuotaExceededError');
                }
                mockLocalStorage[key] = value;
            });

            await expectAsync(service.init()).toBeRejected();
            failing = false;
            await service.init();

            // A second registration would leak a whole set: runInit() overwrites the
            // handles ngOnDestroy needs to remove the first one.
            expect(addSpy.calls.allArgs().filter(args => args[0] === 'visibilitychange').length).toBe(1);
        });

        it('does not measure engagement while disabled', async () => {
            await service.init();
            service.trackPageView('/page');
            httpMock.expectOne(r => r.url.includes('/mp/collect')).flush({});

            service.setEnabled(false);
            jasmine.clock().tick(10000);
            service.setEnabled(true);
            await service.init();

            service.trackEvent('after');
            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            // The 10s spent while collection was off must not be reported as
            // engagement on the first hit after re-enabling.
            expect(req.request.body['events'][0]['params']['engagement_time_msec']).toBeLessThan(1000);
            req.flush({});
        });

        it('does not reopen the engagement interval on focus while disabled', async () => {
            await service.init();
            service.trackPageView('/page');
            httpMock.expectOne(r => r.url.includes('/mp/collect')).flush({});

            service.setEnabled(false);
            // The engagement listeners stay registered after setEnabled(false), so
            // this is the case the gate in setEngagementActive actually exists for.
            // The sibling spec above does not reach it: setEnabled(false) closes the
            // interval directly, and with no event fired during the window the gate
            // is never consulted.
            window.dispatchEvent(new Event('focus'));
            jasmine.clock().tick(10000);

            service.setEnabled(true);
            await service.init();
            service.trackEvent('after');

            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(req.request.body['events'][0]['params']['engagement_time_msec']).toBeLessThan(1000);
            req.flush({});
        });

        it('collects but persists nothing when storage is denied at startup', async () => {
            // writeGaCookie: true is required or persistGaCookie is never reached and
            // the cookie assertion below would pass on unmodified source.
            reconfigureTestBed({ consent: { analyticsStorage: 'denied' }, writeGaCookie: true });
            await service.init();
            service.trackEvent('no_storage');

            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(req.request.body['client_id']).toBeTruthy();
            req.flush({});

            expect(mockLocalStorage['ga_client_id']).toBeUndefined();
            expect(mockLocalStorage['ga_session_id']).toBeUndefined();
            expect(mockLocalStorage['ga_session_number']).toBeUndefined();
            expect(writtenCookies.filter(c => c.startsWith('_ga=') && !/max-age=0\b/.test(c)).length).toBe(0);
        });

        it('keeps the in-memory client id stable across hits while denied', async () => {
            reconfigureTestBed({ consent: { analyticsStorage: 'denied' } });
            await service.init();

            service.trackEvent('one');
            const first = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            const clientId = first.request.body['client_id'];
            first.flush({});

            service.trackEvent('two');
            const second = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(second.request.body['client_id']).toBe(clientId);
            second.flush({});
        });

        it('does not write the extension identity when storage is denied', async () => {
            const chromeLocal: Record<string, any> = {};
            setupChromeMock(chromeLocal, {});
            reconfigureTestBed({ isExtension: true, consent: { analyticsStorage: 'denied' } });

            await service.init();

            // The inline write in loadOrCreateClientIdFromChromeStorage bypasses
            // storeClientId, so gating that method alone does not cover this.
            expect(chromeLocal['ga_client_id']).toBeUndefined();
            clearChromeMock();
        });

        it('deletes the stored client id and _ga cookie on withdrawal', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            await service.init();
            expect(mockLocalStorage['ga_client_id']).toBeDefined();

            service.setConsent({ analyticsStorage: 'denied' });

            expect(mockLocalStorage['ga_client_id']).toBeUndefined();
            expect(mockLocalStorage['ga_session_id']).toBeUndefined();
            expect(mockLocalStorage['ga_session_number']).toBeUndefined();
            expect(writtenCookies.some(c => c.startsWith('_ga=') && /max-age=0\b/.test(c))).toBe(true);
        });

        it('deletes an identifier from a previous visit when booting denied', async () => {
            // The commonest real case: the app read its own banner store and booted
            // denied. No transition occurs, so transition-only deletion misses it.
            mockLocalStorage['ga_client_id'] = 'existing-id';
            reconfigureTestBed({ consent: { analyticsStorage: 'denied' } });

            await service.init();

            expect(mockLocalStorage['ga_client_id']).toBeUndefined();
        });

        it('does not write probe cookies while deleting', async () => {
            reconfigureTestBed({ writeGaCookie: true });
            // Karma's real hostname is `localhost` — a single label, which yields
            // zero registrable-domain candidates. Under that hostname the probing
            // and non-probing implementations behave identically, so without this
            // stub the assertion below cannot tell them apart and passes either way.
            spyOn(service as any, 'getHostname').and.returnValue('www.example.com');
            await service.init();
            writtenCookies.length = 0;

            service.setConsent({ analyticsStorage: 'denied' });

            // Domain discovery works by writing probes. Doing that as the first act
            // of a consent withdrawal is indefensible.
            expect(writtenCookies.every(c => c.startsWith('_ga='))).toBe(true);
        });

        it('keeps collecting with the same client id after withdrawal', async () => {
            await service.init();
            service.trackEvent('before');
            const before = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            const clientId = before.request.body['client_id'];
            before.flush({});

            service.setConsent({ analyticsStorage: 'denied' });
            service.trackEvent('after');

            const after = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            // Withdrawal removes the durable copy; it does not re-identify the user.
            expect(after.request.body['client_id']).toBe(clientId);
            after.flush({});
        });

        it('re-persists the same client id when storage is granted again', async () => {
            await service.init();
            service.trackEvent('first');
            const first = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            const clientId = first.request.body['client_id'];
            first.flush({});

            service.setConsent({ analyticsStorage: 'denied' });
            expect(mockLocalStorage['ga_client_id']).toBeUndefined();

            service.setConsent({ analyticsStorage: 'granted' });

            // The same ID, not a fresh mint: re-identifying someone as a consequence
            // of them *granting* consent would be perverse.
            expect(mockLocalStorage['ga_client_id']).toBe(clientId);
        });

        it('restores session state and number on re-grant', async () => {
            await service.init();
            const sessionNumber = mockLocalStorage['ga_session_number'];
            expect(sessionNumber).toBeDefined();

            service.setConsent({ analyticsStorage: 'denied' });
            service.setConsent({ analyticsStorage: 'granted' });

            // Without this, a reload inside the session window reads null -> 0 and
            // every subsequent hit carries session_number: 0.
            expect(mockLocalStorage['ga_session_number']).toBe(sessionNumber);
            expect(mockLocalStorage['ga_session_id']).toBeDefined();
        });

        it('re-persists an extension identity to chrome.storage, not localStorage', async () => {
            const chromeLocal: Record<string, any> = {};
            const chromeSession: Record<string, any> = {};
            setupChromeMock(chromeLocal, chromeSession);
            reconfigureTestBed({ isExtension: true });

            await service.init();
            const clientId = chromeLocal['ga_client_id'];
            expect(clientId).toBeDefined();

            service.setConsent({ analyticsStorage: 'denied' });
            await service.flushStorage();
            expect(chromeLocal['ga_client_id']).toBeUndefined();

            service.setConsent({ analyticsStorage: 'granted' });
            await service.flushStorage();

            // Writing to localStorage here would leave the ID somewhere
            // loadOrCreateClientIdFromChromeStorage never reads, so the next
            // service-worker start would mint a fresh one.
            expect(chromeLocal['ga_client_id']).toBe(clientId);
            expect(mockLocalStorage['ga_client_id']).toBeUndefined();
            clearChromeMock();
        });

        it('clears the chrome.storage identity on withdrawal', async () => {
            const chromeLocal: Record<string, any> = {};
            const chromeSession: Record<string, any> = {};
            setupChromeMock(chromeLocal, chromeSession);
            reconfigureTestBed({ isExtension: true });

            await service.init();
            service.trackEvent('seed');
            httpMock.expectOne(r => r.url.includes('/mp/collect')).flush({});
            // Asserted before the withdrawal so the post-condition cannot hold
            // vacuously against state that was never written in the first place.
            expect(chromeLocal['ga_client_id']).toBeDefined();
            expect(chromeSession['ga_session_id']).toBeDefined();

            service.setConsent({ analyticsStorage: 'denied' });
            await service.flushStorage();

            expect(chromeLocal['ga_client_id']).toBeUndefined();
            expect(chromeSession['ga_session_id']).toBeUndefined();
            clearChromeMock();
        });

        it('clears localStorage fallback state on an extension with no chrome.storage.session', async () => {
            const chromeLocal: Record<string, any> = {};
            setupChromeMock(chromeLocal, {});
            // MV3 exposes chrome.storage.session to trusted contexts only. Without
            // it, saveSessionState falls back to localStorage — which withdrawal
            // must still clear. This is the case the deliberate absence of an early
            // return after the chrome branch exists for; the sibling spec above
            // never reaches it, because it only asserts on chrome.storage keys.
            delete (window as any).chrome.storage.session;
            reconfigureTestBed({ isExtension: true });

            await service.init();
            service.trackEvent('seed');
            httpMock.expectOne(r => r.url.includes('/mp/collect')).flush({});
            expect(mockLocalStorage['ga_session_id']).toBeDefined();

            service.setConsent({ analyticsStorage: 'denied' });

            expect(mockLocalStorage['ga_session_id']).toBeUndefined();
            expect(mockLocalStorage['ga_last_activity']).toBeUndefined();
            clearChromeMock();
        });

        it('leaves the _ga cookie alone under clientIdSource: storage', async () => {
            reconfigureTestBed({ clientIdSource: 'storage' });
            await service.init();
            writtenCookies.length = 0;

            service.setConsent({ analyticsStorage: 'denied' });

            // 'storage' is documented as "never touch the cookie". Storage deletion
            // still happens; the cookie is not ours to remove.
            expect(writtenCookies.length).toBe(0);
            expect(mockLocalStorage['ga_client_id']).toBeUndefined();
        });

        it('writes nothing to storage when a session rolls while denied', async () => {
            reconfigureTestBed({ consent: { analyticsStorage: 'denied' } });
            await service.init();

            // Past the 30-minute inactivity timeout, so the next hit rolls a session.
            jasmine.clock().tick(31 * 60 * 1000);
            service.trackEvent('after_roll');
            httpMock.expectOne(r => r.url.includes('/mp/collect')).flush({});

            expect(mockLocalStorage['ga_session_id']).toBeUndefined();
            expect(mockLocalStorage['ga_session_number']).toBeUndefined();
        });
    });

    describe('chrome.storage write durability', () => {
        it('serialises writes: a later write does not start until the earlier one lands', async () => {
            reconfigureTestBed({ isExtension: true });
            const mock = setupDeferredChromeMock({ ga_client_id: 'ext-id' });

            // Two writes issued back to back, with nothing released yet.
            (service as any).saveSessionNumber(7);
            (service as any).saveSessionState();
            await drainMicrotasks();

            // Only the first has actually reached chrome.storage.
            expect(mock.calls).toEqual(['local.set:ga_session_number']);

            mock.release();
            await drainMicrotasks();

            expect(mock.calls).toEqual([
                'local.set:ga_session_number',
                'session.set:ga_session_id,ga_last_activity'
            ]);
        });

        it('flushStorage() resolves only once pending writes have landed', async () => {
            reconfigureTestBed({ isExtension: true });
            const mock = setupDeferredChromeMock({ ga_client_id: 'ext-id' });

            (service as any).saveSessionNumber(9);
            let settled = false;
            const flushed = service.flushStorage().then(() => { settled = true; });
            await drainMicrotasks();

            expect(settled).toBe(false);
            expect(mock.localStore['ga_session_number']).toBeUndefined();

            await mock.releaseAll();
            await flushed;

            expect(settled).toBe(true);
            expect(mock.localStore['ga_session_number']).toBe('9');
        });

        it('flushStorage() also awaits a write enqueued while it is waiting', async () => {
            reconfigureTestBed({ isExtension: true });
            const mock = setupDeferredChromeMock({ ga_client_id: 'ext-id' });

            (service as any).saveSessionNumber(1);
            let settled = false;
            const flushed = service.flushStorage().then(() => { settled = true; });
            await drainMicrotasks();

            // A second write arrives mid-flush, as a concurrent trackEvent() could cause.
            (service as any).saveSessionNumber(2);
            mock.release();
            await drainMicrotasks();

            expect(settled).toBe(false);

            await mock.releaseAll();
            await flushed;

            expect(settled).toBe(true);
            expect(mock.localStore['ga_session_number']).toBe('2');
        });

        it('keeps writing after one write rejects', async () => {
            reconfigureTestBed({ isExtension: true });
            const mock = setupDeferredChromeMock({ ga_client_id: 'ext-id' });
            spyOn(console, 'warn');

            (service as any).saveSessionNumber(3);
            // Set explicitly: this spec never calls init(), so this.sessionId is
            // undefined, and Object.assign would copy the key with an undefined
            // value — making toBeDefined() fail for a reason unrelated to the
            // chain. Asserting the real value also makes the check meaningful.
            (service as any).sessionId = 'session-3';
            (service as any).saveSessionState();
            await drainMicrotasks();

            mock.rejectNext();
            await drainMicrotasks();

            // The failure is reported and the chain carries on.
            expect(console.warn).toHaveBeenCalled();
            expect(mock.calls).toContain('session.set:ga_session_id,ga_last_activity');

            await mock.releaseAll();
            await expectAsync(service.flushStorage()).toBeResolved();
            expect(mock.sessionStore['ga_session_id']).toBe('session-3');
        });

        it('flushStorage() resolves immediately on the web path', async () => {
            await service.init();
            await expectAsync(service.flushStorage()).toBeResolved();
        });

        it('await init() implies the initial extension writes have landed', async () => {
            reconfigureTestBed({ isExtension: true });
            const chromeLocal: Record<string, any> = {};
            const chromeSession: Record<string, any> = {};
            setupChromeMock(chromeLocal, chromeSession);

            await service.init();

            expect(chromeLocal['ga_client_id']).toBeDefined();
            expect(chromeLocal['ga_session_number']).toBe('1');
            expect(chromeSession['ga_session_id']).toBeDefined();
        });

        it('consent withdrawal removes after an in-flight write, never before', async () => {
            reconfigureTestBed({ isExtension: true });
            const mock = setupDeferredChromeMock({ ga_client_id: 'ext-id' });

            (service as any).saveSessionNumber(4);
            // Denied while that write is still open. The remove must queue behind
            // it — landing first would let the write resurrect the identifier.
            service.setConsent({ analyticsStorage: 'denied' });
            await drainMicrotasks();

            expect(mock.calls).toEqual(['local.set:ga_session_number']);

            await mock.releaseAll();
            await service.flushStorage();

            expect(mock.calls).toEqual([
                'local.set:ga_session_number',
                'local.remove:ga_client_id,ga_session_number',
                'session.remove:ga_session_id,ga_last_activity'
            ]);
            expect(mock.localStore['ga_session_number']).toBeUndefined();
            expect(mock.localStore['ga_client_id']).toBeUndefined();
        });

        // The only spec that makes enqueueStorageWrite's two-promise split
        // load-bearing. 'should not throw when chrome.storage.local.set rejects'
        // asserts only that init() resolves, so it passes just as happily against
        // a version that returns an ID persisted nowhere at all.
        it('falls back to localStorage when the client-ID write is rejected', async () => {
            reconfigureTestBed({ isExtension: true });
            (window as any).chrome.storage = {
                local: {
                    get: () => Promise.resolve({}),
                    set: () => Promise.reject(new Error('quota exceeded')),
                    remove: () => Promise.resolve()
                },
                session: {
                    get: () => Promise.resolve({}),
                    set: () => Promise.resolve(),
                    remove: () => Promise.resolve()
                }
            };
            spyOn(console, 'warn');

            await service.init();

            // The chrome.storage write failed, so the ID has to have landed in
            // the fallback store — not merely been minted and returned.
            expect(mockLocalStorage['ga_client_id']).toBeDefined();
            service.trackEvent('probe');
            const req = httpMock.expectOne(r => r.url.includes('/mp/collect'));
            expect(req.request.body.client_id).toBe(mockLocalStorage['ga_client_id']);
            req.flush('', { status: 204, statusText: 'No Content' });
        });
    });
});

import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { Router, NavigationEnd, NavigationStart } from '@angular/router';
import { Subject } from 'rxjs';
import { NgGa4Service } from './ng-ga4.service';
import { NG_GA4_CONFIG, NgGa4Config } from './ng-ga4.config';

const MOCK_UUID = '12345678-1234-1234-1234-123456789abc';
const MOCK_TIMESTAMP = 1700000000000;
const MOCK_SESSION_ID = Math.floor(MOCK_TIMESTAMP / 1000).toString();

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

    function configureTestBed(config?: Partial<NgGa4Config>): void {
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
                { provide: NG_GA4_CONFIG, useValue: { ...defaultConfig, ...config } }
            ]
        });

        service = TestBed.inject(NgGa4Service);
        httpMock = TestBed.inject(HttpTestingController);
    }

    function reconfigureTestBed(config?: Partial<NgGa4Config>): void {
        jasmine.clock().uninstall();
        httpMock.verify();
        jasmine.clock().install();
        jasmine.clock().mockDate(new Date(MOCK_TIMESTAMP));
        configureTestBed(config);
    }

    function setupChromeMock(localStore?: Record<string, any>, sessionStore?: Record<string, any>): void {
        const chromeLocal = localStore || {};
        const chromeSession = sessionStore || {};

        (window as any).chrome.storage = {
            local: {
                get: (keys: string[]) => Promise.resolve(
                    keys.reduce((acc: any, k: string) => { if (chromeLocal[k] !== undefined) acc[k] = chromeLocal[k]; return acc; }, {})
                ),
                set: (items: any) => { Object.assign(chromeLocal, items); return Promise.resolve(); }
            },
            session: {
                get: (keys: string[]) => Promise.resolve(
                    keys.reduce((acc: any, k: string) => { if (chromeSession[k] !== undefined) acc[k] = chromeSession[k]; return acc; }, {})
                ),
                set: (items: any) => { Object.assign(chromeSession, items); return Promise.resolve(); }
            }
        };
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

        spyOn(crypto, 'randomUUID').and.returnValue(MOCK_UUID as `${string}-${string}-${string}-${string}-${string}`);

        // Save original chrome.storage (if any) for restoration
        originalChromeStorage = (window as any).chrome?.storage;

        configureTestBed();
    });

    afterEach(() => {
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

        it('should create and store client ID in localStorage', async () => {
            await service.init();
            expect(crypto.randomUUID).toHaveBeenCalled();
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_client_id', MOCK_UUID);
        });

        it('should reuse existing client ID from localStorage', async () => {
            mockLocalStorage['ga_client_id'] = 'existing-id';
            await service.init();
            expect(localStorage.getItem).toHaveBeenCalledWith('ga_client_id');
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

            // Ensure chrome.storage is not set
            clearChromeMock();

            await service.init();
            expect(localStorage.setItem).toHaveBeenCalledWith('ga_client_id', MOCK_UUID);
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
        it('should send to debug endpoint when debug is true', async () => {
            reconfigureTestBed({ debug: true });

            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('debug/mp/collect'));
            expect(req.request.url).toContain('debug/mp/collect');
            req.flush({ validationMessages: [] });
        });

        it('should send to production endpoint when debug is false', async () => {
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            expect(req.request.url).not.toContain('debug/mp/collect');
            req.flush('', { status: 204, statusText: 'No Content' });
        });

        it('should log debug response', async () => {
            reconfigureTestBed({ debug: true });

            spyOn(console, 'log');
            await service.init();
            service.trackPageView('/test');

            const req = httpMock.expectOne((r) => r.url.includes('debug/mp/collect'));
            const mockResponse = { validationMessages: [] };
            req.flush(mockResponse);

            expect(console.log).toHaveBeenCalledWith('[GA4 Debug]', mockResponse);
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

            await service.init();

            expect(localStorage.setItem).toHaveBeenCalledWith('ga_client_id', MOCK_UUID);
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

        it('keeps low-entropy device fields when high-entropy hints are blocked', async () => {
            spyOn<any>(service, 'getUserAgentData').and.returnValue(fakeUaData({ reject: true }));

            await service.init();
            service.trackEvent('x');

            const req = httpMock.expectOne((r) => r.url.includes('mp/collect'));
            const device = req.request.body.device;
            expect(device.category).toBe('desktop');
            expect('operating_system' in device).toBe(false);
            expect('browser' in device).toBe(false);
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

        it('always uses XHR in debug mode so the validation response can be read', async () => {
            reconfigureTestBed({ transport: 'beacon', debug: true });
            installBeacon();

            await service.init();
            service.trackEvent('x');

            expect(beaconSpy).not.toHaveBeenCalled();
            const req = httpMock.expectOne((r) => r.url.includes('debug/mp/collect'));
            req.flush({ validationMessages: [] });
        });
    });
});

import { Inject, Injectable, OnDestroy, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { NG_GA4_CONFIG, NgGa4Config } from './ng-ga4.config';
import { countryFromTimeZone } from './tz-country';
import { deviceFromUserAgent, UaDeviceInfo } from './ua-device';
import { formatGaCookie, mintGtagClientId, parseGaCookie, readCookieValue, registrableDomainCandidates } from './ga-cookie';

interface Ga4Device {
    language?: string;
    screen_resolution?: string;
    category?: string;
    operating_system?: string;
    operating_system_version?: string;
    browser?: string;
    browser_version?: string;
}

interface Ga4UserLocation {
    country_id?: string;
}

@Injectable()
export class NgGa4Service implements OnDestroy {
    private clientId: string;
    private sessionId: string;
    private sessionNumber = 0;
    private lastActivityTimestamp = 0;
    private initialized = false;
    private routerSubscription: Subscription;
    private device: Ga4Device | null = null;
    private userLocation: Ga4UserLocation | null = null;
    private pendingCalls: Array<() => void> = [];
    private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    // gtag.js's own default _ga lifetime.
    private readonly GA_COOKIE_MAX_AGE_SECONDS = 63072000;
    private readonly GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
    private readonly GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

    private readonly isBrowser: boolean;

    constructor(
        private http: HttpClient,
        private router: Router,
        @Inject(NG_GA4_CONFIG) private config: NgGa4Config,
        @Inject(PLATFORM_ID) platformId: object
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    async init(): Promise<void> {
        // Every collection path below reads a browser-only global (localStorage,
        // crypto, screen, navigator, window.location), so on the server this must
        // be inert rather than merely quiet — an APP_INITIALIZER that throws takes
        // the whole SSR/prerender bootstrap down with it.
        if (!this.isBrowser || !this.config.enabled || this.initialized) {
            return;
        }
        this.initialized = true;

        const clientId = await this.loadOrCreateClientId();
        this.sessionNumber = await this.loadSessionNumber();
        await this.restoreOrStartSession();
        await this.collectContext();
        // Assign clientId last so the `!this.clientId` guard in track* gates sends
        // until device/country context is ready. Calls made during this window are
        // queued (see trackEvent/trackPageView) and drained here so a concurrent
        // APP_INITIALIZER (e.g. extension_installed) cannot lose its event.
        this.clientId = clientId;
        this.drainPendingCalls();

        this.routerSubscription = this.router.events
            .pipe(filter(event => event instanceof NavigationEnd))
            .subscribe((event: NavigationEnd) => {
                this.trackPageView(event.urlAfterRedirects);
            });
    }

    ngOnDestroy(): void {
        this.routerSubscription?.unsubscribe();
    }

    trackPageView(pagePath: string, pageTitle?: string): void {
        // Dropped, not queued: the server has no client identity to attach a hit to,
        // and replaying queued events after hydration would double-count the view.
        if (!this.isBrowser || !this.config.enabled) {
            return;
        }
        if (!this.clientId) {
            if (this.initialized) {
                this.pendingCalls.push(() => this.trackPageView(pagePath, pageTitle));
            }
            return;
        }

        this.ensureSession();

        const params: Record<string, any> = {
            page_location: this.config.siteUrl
                ? this.joinSiteUrl(this.config.siteUrl, pagePath)
                : window.location.href,
            page_title: pageTitle,
            engagement_time_msec: 100,
            session_id: this.sessionId,
            session_number: this.sessionNumber,
            ...(this.config.appVersion ? { app_version: this.config.appVersion } : {})
        };

        this.sendToGA4([{ name: 'page_view', params }]);
    }

    trackEvent(name: string, params?: Record<string, any>): void {
        // See trackPageView: inert on the server, and deliberately not queued.
        if (!this.isBrowser || !this.config.enabled) {
            return;
        }
        if (!this.clientId) {
            if (this.initialized) {
                this.pendingCalls.push(() => this.trackEvent(name, params));
            }
            return;
        }

        this.ensureSession();

        this.sendToGA4([{
            name,
            params: {
                engagement_time_msec: 100,
                session_id: this.sessionId,
                session_number: this.sessionNumber,
                ...params,
                ...(this.config.appVersion ? { app_version: this.config.appVersion } : {})
            }
        }]);
    }

    private drainPendingCalls(): void {
        const calls = this.pendingCalls;
        this.pendingCalls = [];
        for (const call of calls) {
            call();
        }
    }

    private sendToGA4(events: Array<{ name: string; params?: Record<string, any> }>): void {
        const url = this.collectUrl(this.GA4_ENDPOINT);

        const body: {
            client_id: string;
            events: Array<{ name: string; params?: Record<string, any> }>;
            device?: Ga4Device;
            user_location?: Ga4UserLocation;
        } = {
            client_id: this.clientId,
            // debug_mode has to ride on every event in the batch — DebugView only
            // surfaces the individual events that carry it, not the request.
            events: this.config.debug
                ? events.map(event => ({ ...event, params: { ...event.params, debug_mode: 1 } }))
                : events
        };
        // `device` and `user_location` are request-level fields (siblings of
        // `client_id`/`events`), not per-event params. /mp/collect does not infer
        // device/geo from the request, so we supply them explicitly.
        if (this.device) {
            body.device = this.device;
        }
        if (this.userLocation) {
            body.user_location = this.userLocation;
        }

        // The validation endpoint records nothing — "events sent to the validation
        // server don't show up in reports" — so it can only ever be a side channel.
        // The real hit below still goes to production, over the configured transport,
        // so debug traffic exercises the same path production will.
        if (this.config.debug) {
            this.sendForValidation(body);
        }

        if (this.config.transport === 'xhr') {
            this.sendViaXhr(url, body);
            return;
        }

        // Default ('beacon'): prefer transports that survive page/tab unload so events
        // fired right before the user leaves are not dropped. sendBeacon → fetch(keepalive)
        // → XHR (last resort, aborted on unload but better than silently losing the hit).
        const payload = JSON.stringify(body);
        if (this.trySendBeacon(url, payload)) {
            return;
        }
        if (this.tryFetchKeepalive(url, payload)) {
            return;
        }
        this.sendViaXhr(url, body);
    }

    private collectUrl(endpoint: string): string {
        return `${endpoint}?measurement_id=${this.config.measurementId}&api_secret=${this.config.apiSecret}`;
    }

    private sendForValidation(body: object): void {
        this.http.post<{ validationMessages?: unknown[] }>(this.collectUrl(this.GA4_DEBUG_ENDPOINT), body).subscribe({
            next: (response) => {
                // Only speak up when something is actually wrong. Logging the whole
                // envelope either way made a clean payload and a rejected one look
                // alike, which defeated the point of running validation at all.
                const messages = response?.validationMessages ?? [];
                if (messages.length) {
                    console.warn('[ng-ga4] GA4 rejected this payload:', messages);
                }
            },
            error: (err) => this.logHttpError(err)
        });
    }

    private sendViaXhr(url: string, body: object): void {
        this.http.post(url, body, { responseType: 'text' }).subscribe({
            error: (err) => this.logHttpError(err)
        });
    }

    private trySendBeacon(url: string, payload: string): boolean {
        const nav = this.getNavigator();
        if (!nav || typeof nav.sendBeacon !== 'function') {
            return false;
        }
        try {
            // GA4's /mp/collect expects an application/json body, so wrap the payload in a
            // typed Blob rather than passing a string — a string would be sent as text/plain
            // and the hit would be silently dropped (the endpoint still answers 2xx). This is
            // a non-"simple" cross-origin request that incurs a CORS preflight, which GA4
            // answers — the same preflight the XHR path already relies on.
            const blob = new Blob([payload], { type: 'application/json' });
            return nav.sendBeacon(url, blob);
        } catch {
            return false;
        }
    }

    private tryFetchKeepalive(url: string, payload: string): boolean {
        const fetchFn = this.getFetch();
        if (!fetchFn) {
            return false;
        }
        try {
            // application/json to match what GA4's /mp/collect expects (see trySendBeacon).
            // Default CORS mode (not 'no-cors') so the application/json header is permitted and
            // genuine HTTP/network failures still surface to logHttpError; GA4 returns the CORS
            // headers the XHR path already depends on.
            fetchFn(url, {
                method: 'POST',
                body: payload,
                keepalive: true,
                headers: { 'Content-Type': 'application/json' }
            }).catch((err: unknown) => this.logHttpError(err));
            return true;
        } catch {
            return false;
        }
    }

    // Indirection seams (mirrors getUserAgentData/getTimeZone) so tests can stub the
    // platform globals without mutating them.
    private getNavigator(): Navigator | undefined {
        return typeof navigator !== 'undefined' ? navigator : undefined;
    }

    private getFetch(): typeof fetch | undefined {
        return typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;
    }

    private getCookieJar(): string {
        try {
            return typeof document !== 'undefined' ? document.cookie : '';
        } catch {
            // document.cookie throws in some sandboxed iframes.
            return '';
        }
    }

    private setCookie(cookie: string): void {
        try {
            if (typeof document !== 'undefined') {
                document.cookie = cookie;
            }
        } catch {
            // See getCookieJar.
        }
    }

    private getHostname(): string {
        return typeof window !== 'undefined' && window.location ? window.location.hostname : '';
    }

    private logHttpError(err: any): void {
        const redact = (v: unknown): any =>
            typeof v === 'string' ? v.replace(/api_secret=[^&\s]*/g, 'api_secret=***') : v;
        console.error('GA4 analytics error:', {
            status: err?.status,
            statusText: err?.statusText,
            message: redact(err?.message),
            url: redact(err?.url)
        });
    }

    private joinSiteUrl(siteUrl: string, pagePath: string): string {
        const base = siteUrl.replace(/\/+$/, '');
        const path = pagePath.startsWith('/') ? pagePath : '/' + pagePath;
        return base + path;
    }

    // --- Device & location context (request-level GA4 fields) ---

    private async collectContext(): Promise<void> {
        try {
            this.userLocation = this.collectUserLocation();
        } catch (err) {
            console.warn('[ng-ga4] user_location collection failed', err);
            this.userLocation = null;
        }
        try {
            this.device = await this.collectDevice();
        } catch (err) {
            console.warn('[ng-ga4] device collection failed', err);
            this.device = null;
        }
    }

    private collectUserLocation(): Ga4UserLocation | null {
        const country = countryFromTimeZone(this.getTimeZone());
        return country ? { country_id: country } : null;
    }

    private async collectDevice(): Promise<Ga4Device | null> {
        if (typeof navigator === 'undefined') {
            return null;
        }
        const device: Ga4Device = {};

        if (typeof navigator.language === 'string' && navigator.language) {
            device.language = navigator.language;
        }
        if (typeof screen !== 'undefined' && screen.width && screen.height) {
            device.screen_resolution = `${screen.width}x${screen.height}`;
        }

        const uaData = this.getUserAgentData();
        if (uaData) {
            device.category = uaData.mobile ? 'mobile' : 'desktop';
            try {
                const high = await uaData.getHighEntropyValues(['platform', 'platformVersion', 'fullVersionList']);
                if (high.platform) {
                    device.operating_system = high.platform;
                }
                if (high.platformVersion) {
                    device.operating_system_version = high.platformVersion;
                }
                const browser = this.pickBrowser(high.fullVersionList);
                if (browser) {
                    device.browser = browser.brand;
                    device.browser_version = browser.version;
                }
            } catch {
                // High-entropy hints unavailable (blocked, or a permissions policy denies
                // them) — the UA-string fallback below fills what we did not get.
            }
        }

        // Client Hints are authoritative where present; the UA string only fills gaps.
        // That covers both browsers with no userAgentData at all (Safari, Firefox) and
        // Chromium whose high-entropy hints were refused above.
        this.fillDeviceGapsFromUserAgent(device);

        return Object.keys(device).length ? device : null;
    }

    private fillDeviceGapsFromUserAgent(device: Ga4Device): void {
        const ua = this.getUserAgentString();
        if (!ua) {
            return;
        }
        const parsed = deviceFromUserAgent(ua, navigator.maxTouchPoints ?? 0);
        for (const key of Object.keys(parsed) as Array<keyof UaDeviceInfo>) {
            if (device[key] === undefined && parsed[key] !== undefined) {
                device[key] = parsed[key];
            }
        }
    }

    private pickBrowser(list: Array<{ brand: string; version: string }> | undefined): { brand: string; version: string } | null {
        if (!Array.isArray(list)) {
            return null;
        }
        // Skip the GREASE placeholder ("Not.A/Brand") and the generic "Chromium" engine entry
        // so we report the real product (e.g. Chrome, Edge).
        const real = list.find(b => b && b.brand && !/Not.?A.?Brand|Chromium/i.test(b.brand));
        if (!real) {
            return null;
        }
        const brand = real.brand.replace(/^Google\s+/, '').replace(/^Microsoft\s+/, '');
        return { brand, version: real.version };
    }

    private getTimeZone(): string | undefined {
        if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
            return undefined;
        }
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    private getUserAgentData(): any {
        return typeof navigator !== 'undefined' ? (navigator as any).userAgentData : undefined;
    }

    private getUserAgentString(): string | undefined {
        return typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
    }

    private ensureSession(): void {
        if (Date.now() - this.lastActivityTimestamp > this.SESSION_TIMEOUT_MS) {
            this.startNewSession();
        }
        this.lastActivityTimestamp = Date.now();
        this.saveSessionState();
    }

    private async restoreOrStartSession(): Promise<void> {
        const state = await this.loadSessionState();
        if (state && (Date.now() - state.lastActivityTimestamp) <= this.SESSION_TIMEOUT_MS) {
            this.sessionId = state.sessionId;
            this.lastActivityTimestamp = state.lastActivityTimestamp;
        } else {
            this.startNewSession();
        }
    }

    private startNewSession(): void {
        this.sessionId = Math.floor(Date.now() / 1000).toString();
        this.sessionNumber++;
        this.saveSessionNumber(this.sessionNumber);
        this.lastActivityTimestamp = Date.now();
        this.saveSessionState();
    }

    // --- Storage: session number (persistent — chrome.storage.local / localStorage) ---

    private async loadSessionNumber(): Promise<number> {
        if (this.config.isExtension) {
            return this.loadSessionNumberFromChromeStorage();
        }
        return this.loadSessionNumberFromLocalStorage();
    }

    private loadSessionNumberFromLocalStorage(): number {
        return this.parseIntSafe(localStorage.getItem('ga_session_number'));
    }

    private async loadSessionNumberFromChromeStorage(): Promise<number> {
        if (!chrome?.storage) {
            return this.loadSessionNumberFromLocalStorage();
        }
        try {
            const result = await chrome.storage.local.get(['ga_session_number']);
            return this.parseIntSafe(result['ga_session_number']);
        } catch (err) {
            console.warn('[ng-ga4] chrome.storage.local.get failed, falling back to localStorage', err);
            return this.loadSessionNumberFromLocalStorage();
        }
    }

    private saveSessionNumber(sessionNumber: number): void {
        if (this.config.isExtension && chrome?.storage) {
            chrome.storage.local.set({ ga_session_number: sessionNumber.toString() })
                .catch(err => console.warn('[ng-ga4] chrome.storage.local.set failed', err));
        } else {
            localStorage.setItem('ga_session_number', sessionNumber.toString());
        }
    }

    private parseIntSafe(value: unknown): number {
        if (typeof value !== 'string' || value.length === 0) {
            return 0;
        }
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : 0;
    }

    // --- Storage: session state (ephemeral — chrome.storage.session / localStorage) ---

    private async loadSessionState(): Promise<{ sessionId: string; lastActivityTimestamp: number } | null> {
        if (this.config.isExtension && chrome?.storage?.session) {
            try {
                const result = await chrome.storage.session.get(['ga_session_id', 'ga_last_activity']);
                if (result['ga_session_id'] && result['ga_last_activity']) {
                    const ts = this.parseIntSafe(result['ga_last_activity']);
                    if (ts > 0) {
                        return { sessionId: result['ga_session_id'], lastActivityTimestamp: ts };
                    }
                }
                return null;
            } catch (err) {
                console.warn('[ng-ga4] chrome.storage.session.get failed, falling back to localStorage', err);
            }
        }
        const sessionId = localStorage.getItem('ga_session_id');
        const lastActivity = localStorage.getItem('ga_last_activity');
        if (sessionId && lastActivity) {
            const ts = this.parseIntSafe(lastActivity);
            if (ts > 0) {
                return { sessionId, lastActivityTimestamp: ts };
            }
        }
        return null;
    }

    private saveSessionState(): void {
        if (this.config.isExtension && chrome?.storage?.session) {
            chrome.storage.session.set({ ga_session_id: this.sessionId, ga_last_activity: this.lastActivityTimestamp.toString() })
                .catch(err => console.warn('[ng-ga4] chrome.storage.session.set failed', err));
        } else {
            localStorage.setItem('ga_session_id', this.sessionId);
            localStorage.setItem('ga_last_activity', this.lastActivityTimestamp.toString());
        }
    }

    // --- Storage: client ID (persistent — chrome.storage.local / localStorage) ---

    private async loadOrCreateClientId(): Promise<string> {
        if (this.config.isExtension) {
            return this.loadOrCreateClientIdFromChromeStorage();
        }
        return this.loadOrCreateClientIdForWeb();
    }

    // gtag.js keeps its client ID in the `_ga` cookie, which is scoped to the
    // registrable domain; ours lived in origin-scoped localStorage. A site running
    // both therefore counted one human as two users. Preferring the cookie makes the
    // two agree, and costs nothing where no cookie exists.
    private loadOrCreateClientIdForWeb(): string {
        const source = this.config.clientIdSource ?? 'auto';

        if (source !== 'storage') {
            const fromCookie = this.readGaCookieClientId();
            if (fromCookie) {
                // Mirror it, so a later gtag removal or cookie expiry does not flip
                // identity back to whatever stale value localStorage still holds.
                this.storeClientId(fromCookie);
                return fromCookie;
            }
        }

        // 'cookie' means the cookie is authoritative, so with none present we mint in
        // gtag's own shape rather than adopting a legacy UUID. That re-identifies an
        // existing user exactly once, which is why it is opt-in and not the default.
        if (source === 'cookie') {
            const minted = mintGtagClientId(Date.now(), this.randomClientIdSeed());
            this.storeClientId(minted);
            this.persistGaCookie(minted);
            return minted;
        }

        const stored = this.loadOrCreateClientIdFromLocalStorage();
        // The source check is load-bearing: 'storage' means "never touch the cookie",
        // so it has to override writeGaCookie rather than combining with it.
        if (source !== 'storage' && this.config.writeGaCookie) {
            // Write the ID we already have rather than minting: re-identifying users
            // is the harm this whole feature exists to avoid. The cost is a _ga whose
            // payload may be a UUID instead of gtag's numeric pair — GA4 accepts any
            // client_id string, and if gtag later rejects the shape it rewrites the
            // cookie, which our next read adopts. One flip, then convergence.
            this.persistGaCookie(stored);
        }
        return stored;
    }

    private randomClientIdSeed(): number {
        const buffer = new Uint32Array(1);
        crypto.getRandomValues(buffer);
        // [1, 2^31 - 1], the range gtag draws its first field from.
        return (buffer[0] % 2147483647) + 1;
    }

    // Named `persistGaCookie`, not `writeGaCookie`, so it is never confused at a
    // glance with the `config.writeGaCookie` flag that gates it.
    private persistGaCookie(clientId: string): void {
        const domain = this.discoverCookieDomain();
        const components = domain ? domain.split('.').length : 1;
        const attributes = [
            `path=/`,
            `max-age=${this.GA_COOKIE_MAX_AGE_SECONDS}`,
            `SameSite=Lax`,
            ...(domain ? [`domain=.${domain}`] : [])
        ];
        // readCookieValue decodeURIComponents on read, so an unencoded value here is a
        // latent trap: a clientId containing e.g. "; max-age=0" would be mirrored into
        // localStorage verbatim and then re-emitted raw on the next write, injecting
        // cookie attributes. encodeURIComponent is a no-op for gtag's numeric pairs and
        // our UUIDs, so this costs nothing on the path that matters.
        const value = encodeURIComponent(formatGaCookie(clientId, components));
        this.setCookie(`_ga=${value}; ${attributes.join('; ')}`);
    }

    // There is no public suffix list in the browser, so the registrable domain has to
    // be discovered: trial-set a throwaway cookie at each candidate shortest-first and
    // keep the first that sticks. Browsers refuse cookies scoped to a public suffix,
    // which makes that refusal the oracle. Returns null when no domain attribute is
    // wanted at all (single-label hosts, IP literals).
    private discoverCookieDomain(): string | null {
        for (const candidate of registrableDomainCandidates(this.getHostname())) {
            // A per-attempt name, not a fixed one: document.cookie exposes no domain or
            // path, so two tabs on sibling subdomains probing concurrently would
            // otherwise overwrite each other's probe and misread the result.
            const probe = `_ng_ga4_probe_${this.randomNonce()}`;
            this.setCookie(`${probe}=1; path=/; domain=.${candidate}`);
            if (readCookieValue(this.getCookieJar(), probe) !== null) {
                this.setCookie(`${probe}=; path=/; domain=.${candidate}; max-age=0`);
                return candidate;
            }
        }
        return null;
    }

    private randomNonce(): string {
        const buffer = new Uint32Array(1);
        crypto.getRandomValues(buffer);
        return buffer[0].toString(36);
    }

    private readGaCookieClientId(): string | null {
        try {
            // Belt-and-braces: getCookieJar already swallows and parseGaCookie/
            // readCookieValue are pure, so nothing here should actually throw. This
            // path runs inside an APP_INITIALIZER (init()), though, and no future
            // change to this seam should be able to fail app bootstrap — see tier-0
            // issue #10 on getCookieJar for why that failure mode matters here.
            const value = readCookieValue(this.getCookieJar(), '_ga');
            return value === null ? null : parseGaCookie(value);
        } catch {
            // Cookie access is denied outright in some sandboxed iframes. Falling
            // back to storage is strictly better than failing init().
            return null;
        }
    }

    private storeClientId(clientId: string): void {
        localStorage.setItem('ga_client_id', clientId);
    }

    private loadOrCreateClientIdFromLocalStorage(): string {
        let clientId = localStorage.getItem('ga_client_id');
        if (!clientId) {
            clientId = crypto.randomUUID();
            this.storeClientId(clientId);
        }
        return clientId;
    }

    private async loadOrCreateClientIdFromChromeStorage(): Promise<string> {
        if (!chrome?.storage) {
            return this.loadOrCreateClientIdFromLocalStorage();
        }
        try {
            const result = await chrome.storage.local.get(['ga_client_id']);
            if (result['ga_client_id']) {
                return result['ga_client_id'];
            }
            const clientId = crypto.randomUUID();
            await chrome.storage.local.set({ ga_client_id: clientId });
            return clientId;
        } catch (err) {
            console.warn('[ng-ga4] chrome.storage.local failed, falling back to localStorage', err);
            return this.loadOrCreateClientIdFromLocalStorage();
        }
    }
}

import { Inject, Injectable, OnDestroy, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { NG_GA4_CONFIG, NgGa4Config, NgGa4CookieOptions } from './ng-ga4.config';
import { countryFromTimeZone } from './tz-country';
import { deviceFromUserAgent, UaDeviceInfo } from './ua-device';
import { EngagementTimer } from './engagement-timer';
import { formatGaCookie, isGtagClientId, mintGtagClientId, parseGaCookie, readCookieValue, registrableDomainCandidates } from './ga-cookie';

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
    private visibilityListener?: () => void;
    private pagehideListener?: () => void;
    private focusListener?: () => void;
    private blurListener?: () => void;
    private chromeStorageListener?: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;
    // Only read when siteUrl is configured: flushEngagement() then joins it
    // onto siteUrl for the hide-time event's page_location, since that event
    // has no page path of its own — this names the page the trailing time was
    // accrued on, which is whatever page_view fired last. Without siteUrl,
    // flushEngagement() uses window.location.href directly instead, and this
    // field is never read.
    private lastPagePath = '/';
    private device: Ga4Device | null = null;
    private userLocation: Ga4UserLocation | null = null;
    private pendingCalls: Array<() => void> = [];
    private engagement: EngagementTimer | null = null;
    // Resolved once, in init(), by resolveEngagementEventName() — validating on
    // every flush would warn on every window switch for a misconfigured name.
    private engagementEventName = 'page_engagement';
    private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    // Below this, a flush is noise: repeated hide/show cycles would otherwise emit
    // an event per cycle. The time is not discarded — it stays in the accumulator
    // and rides out on the next flush or hit. Blur never reaches this at all: it
    // does not flush regardless of how much time accrued (see registerEngagementListeners).
    private readonly MIN_ENGAGEMENT_FLUSH_MS = 1000;
    // gtag.js's own default _ga lifetime.
    private readonly GA_COOKIE_MAX_AGE_SECONDS = 63072000;
    private readonly GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
    private readonly GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';
    // The Measurement Protocol's reserved automatically-collected/recommended event
    // names: sending a custom event under one of these is accepted with 2xx and
    // silently dropped. Not exhaustive of every reserved name Google documents, but
    // covers the ones a consumer could plausibly type as an engagementEventName.
    private readonly RESERVED_MP_EVENT_NAMES = new Set([
        'user_engagement', 'session_start', 'first_visit', 'first_open', 'error',
        'in_app_purchase', 'os_update', 'app_remove', 'app_update', 'app_clear_data',
        'ad_click', 'ad_impression', 'ad_query', 'ad_exposure', 'adunit_exposure',
        'notification_dismiss', 'notification_foreground', 'notification_open',
        'notification_receive', 'screen_view'
    ]);

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

        // Created here rather than in the constructor: the constructor also runs
        // on the server, where `document` does not exist.
        this.engagement = new EngagementTimer(() => this.monotonicNow(), this.isPageEngaged());
        // Registered immediately, not after the awaits below: collectContext()
        // alone awaits getHighEntropyValues(), which a slow or stalled browser can
        // hold open for a long time. A blur during that window previously had
        // nothing observing it — no listener existed yet — so the timer kept
        // ticking as "engaged" the whole time, one measured case reaching 120s of
        // phantom engagement on a blurred window. flushEngagement() already guards
        // on `!this.clientId`, so it's safe to have listeners live before clientId
        // (and device/location context) are ready — see resolveEngagementEventName()
        // for the one thing that must still be resolved before any flush can fire.
        this.registerEngagementListeners();
        this.engagementEventName = this.resolveEngagementEventName();

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

        this.registerSessionSyncListener();
    }

    ngOnDestroy(): void {
        this.routerSubscription?.unsubscribe();
        if (this.visibilityListener && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.visibilityListener);
        }
        if (this.pagehideListener && typeof window !== 'undefined') {
            window.removeEventListener('pagehide', this.pagehideListener);
        }
        if (this.focusListener && typeof window !== 'undefined') {
            window.removeEventListener('focus', this.focusListener);
        }
        if (this.blurListener && typeof window !== 'undefined') {
            window.removeEventListener('blur', this.blurListener);
        }
        if (this.chromeStorageListener && chrome?.storage?.onChanged) {
            chrome.storage.onChanged.removeListener(this.chromeStorageListener);
        }
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
        this.lastPagePath = pagePath;

        this.ensureSession();

        const params: Record<string, any> = {
            page_location: this.config.siteUrl
                ? this.joinSiteUrl(this.config.siteUrl, pagePath)
                : window.location.href,
            page_title: pageTitle,
            engagement_time_msec: this.consumeEngagementTime(),
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

        // consumeEngagementTime() drains the accumulator to zero. If the caller
        // already supplied engagement_time_msec, the ...params spread below would
        // overwrite that drained value anyway — so the measured time must never be
        // consumed in the first place, or it is lost for good rather than merely
        // unused on this hit.
        const callerSuppliedEngagement = params !== undefined && 'engagement_time_msec' in params;

        this.sendToGA4([{
            name,
            params: {
                ...(callerSuppliedEngagement ? {} : { engagement_time_msec: this.consumeEngagementTime() }),
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

    private sendToGA4(
        events: Array<{ name: string; params?: Record<string, any> }>,
        forceBeacon = false
    ): void {
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

        // forceBeacon is for sends that happen as the page goes away, where XHR is
        // aborted and the hit is simply lost. Overriding an explicit transport
        // choice is deliberate: losing the event outright is worse than skipping
        // the consumer's HTTP interceptors for it.
        if (this.config.transport === 'xhr' && !forceBeacon) {
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

    private getProtocol(): string {
        return typeof window !== 'undefined' && window.location ? window.location.protocol : '';
    }

    // GA4 counts engagement as time the page is *in focus*, not merely visible —
    // a tab left visible behind another window is not engaged. Both signals are
    // needed: visibilitychange alone misses window and application switches.
    private isPageEngaged(): boolean {
        const doc = this.getDocument();
        if (!doc) {
            // Without a document there is no visibilitychange, focus or blur target
            // — no signal that could ever close the span. Starting "engaged" here
            // would run the clock forever, since registerEngagementListeners() bails
            // out in exactly this case too: nothing is watching to stop it. Narrow in
            // practice, but this library explicitly targets MV3 service workers.
            return false;
        }
        const visible = doc.visibilityState !== 'hidden';
        // hasFocus() is unavailable in some embedded contexts; assume focused
        // rather than silently reporting zero engagement everywhere. Safe unlike
        // the missing-document case above: visibilitychange still fires here, so
        // there remains a signal that can end the span.
        const focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
        return visible && focused;
    }

    private getDocument(): Document | undefined {
        return typeof document !== 'undefined' ? document : undefined;
    }

    // Date.now() advances while the OS is suspended, so a closed laptop lid
    // would report hours of "engagement" — no blur or visibilitychange fires to
    // close the span while the machine sleeps. performance.now() is monotonic
    // and generally does not advance across suspend. Rounded because it is
    // fractional, and consumers of this timer deal in whole milliseconds.
    private monotonicNow(): number {
        return typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? Math.round(performance.now())
            : Date.now();
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

    // engagement is always constructed before clientId is set, so the callers'
    // !this.clientId guard makes this unreachable today—fallback exists if that changes.
    private consumeEngagementTime(): number {
        return this.engagement?.consume() ?? 0;
    }

    private registerEngagementListeners(): void {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
        }
        // visibilitychange closes the interval and flushes on disengagement — a
        // hidden tab is a real end of the visit-so-far, worth a network hit.
        this.visibilityListener = () => {
            const engaged = this.isPageEngaged();
            this.engagement?.setEngaged(engaged);
            if (!engaged) {
                this.flushEngagement();
            }
        };
        // blur stops the clock but deliberately does not flush. MIN_ENGAGEMENT_FLUSH_MS
        // is a floor on *accrued time*, not on flush rate, so it only suppresses window
        // switches faster than a second of focused time — ten alt-tab cycles still
        // measured ten network hits before this. The time is not lost: it stays in the
        // accumulator and rides out on the next hit, or on the eventual hide/pagehide,
        // which still fires on tab close. Sending per blur would be an event per window
        // switch for no extra data.
        this.blurListener = () => {
            this.engagement?.setEngaged(false);
        };
        // The counterpart to blur: re-engage on refocus, nothing to flush here either
        // since focus only ever opens the interval, never closes it.
        this.focusListener = () => {
            this.engagement?.setEngaged(this.isPageEngaged());
        };
        // pagehide covers cross-document navigation and tab close, where a hidden
        // visibilitychange may not be delivered. unload/beforeunload would be the
        // obvious fallback for that, but iOS Safari drops those too, which is why
        // pagehide is what's actually wired here. setEngaged(false) closes the
        // interval before flushing so a bfcache restore minutes later can't have
        // that dead time reopened and counted as foreground time.
        this.pagehideListener = () => {
            this.engagement?.setEngaged(false);
            this.flushEngagement();
        };
        document.addEventListener('visibilitychange', this.visibilityListener);
        window.addEventListener('focus', this.focusListener);
        window.addEventListener('blur', this.blurListener);
        window.addEventListener('pagehide', this.pagehideListener);
    }

    // The trailing chunk of foreground time is otherwise lost: for a visit that
    // fires only the initial page_view, that is the entire visit, which is why
    // engagement metrics read as ~0 without this.
    private flushEngagement(): void {
        if (this.config.sendEngagementOnHide === false || !this.clientId) {
            return;
        }
        // Read without draining: below the floor, the time must stay in the
        // accumulator rather than being discarded, so it rides out on the next
        // flush or hit. This is also still what deduplicates the visibilitychange
        // and pagehide listeners — whichever fires second finds a drained
        // accumulator, which reports 0 via pending(), well below the floor.
        if ((this.engagement?.pending() ?? 0) < this.MIN_ENGAGEMENT_FLUSH_MS) {
            return;
        }
        const engagementTime = this.consumeEngagementTime();
        // Adopt before judging expiry: the in-memory timestamp can go stale while
        // this tab sits visible and idle, and judging against that stale value
        // would treat a session another tab kept alive as dead.
        this.adoptPersistedSessionIfNewer();
        // The user is leaving. Rolling an already-expired session here would land
        // the trailing time in a session that never had a page view, and bump
        // session_number for a session that never really happened. Attribute it to
        // the session it was accrued in and let the next real visit do the rolling.
        if (Date.now() - this.lastActivityTimestamp <= this.SESSION_TIMEOUT_MS) {
            this.ensureSession();
        }
        this.sendToGA4([{
            name: this.engagementEventName,
            params: {
                engagement_time_msec: engagementTime,
                session_id: this.sessionId,
                session_number: this.sessionNumber,
                page_location: this.config.siteUrl
                    ? this.joinSiteUrl(this.config.siteUrl, this.lastPagePath)
                    : window.location.href,
                ...(this.config.appVersion ? { app_version: this.config.appVersion } : {})
            }
        }], true);
    }

    // Follows resolveClientIdSource(): validated once here, not trusted verbatim,
    // and only once — called from init(), not from flushEngagement(), so a
    // misconfigured name warns once rather than on every window switch. GA4
    // returns 2xx and silently drops a hit carrying an invalid or reserved event
    // name — the worst failure mode, since nothing in the response reveals it
    // happened. Real Measurement Protocol rules, not a guess: `ga_dwell`,
    // `my event`, `9lives`, a 60-character name and `_x` all used to pass the old
    // four-name blocklist and get silently dropped by GA4.
    private resolveEngagementEventName(): string {
        const configured = this.config.engagementEventName;
        if (configured === undefined) {
            return 'page_engagement';
        }
        if (this.isValidGa4EventName(configured)) {
            return configured;
        }
        console.warn(`[ng-ga4] Invalid engagementEventName "${configured}", falling back to "page_engagement".`);
        return 'page_engagement';
    }

    // Mirrors the Measurement Protocol's actual event-name constraints: starts
    // with a letter, letters/digits/underscores only, at most 40 characters, not
    // one of the three reserved prefixes, and not a reserved event name outright.
    private isValidGa4EventName(name: string): boolean {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) {
            return false;
        }
        if (/^(ga_|google_|firebase_)/.test(name)) {
            return false;
        }
        return !this.RESERVED_MP_EVENT_NAMES.has(name);
    }

    private ensureSession(): void {
        // Adopt whatever another tab wrote most recently before deciding anything.
        // Without this, in-memory state read once at init() goes stale the moment
        // any other tab rolls, and this tab sends the dead session forever.
        this.adoptPersistedSessionIfNewer();
        // Evaluated against the adopted timestamp, not the pre-adoption one.
        if (Date.now() - this.lastActivityTimestamp > this.SESSION_TIMEOUT_MS) {
            this.startNewSession();
        }
        this.lastActivityTimestamp = Date.now();
        this.saveSessionState();
    }

    // Adopt whatever another tab wrote most recently. Split out of ensureSession()
    // because the hide-time flush needs to adopt without rolling: it must decide
    // expiry against fresh state, not against a timestamp that went stale while
    // this tab sat visible and idle.
    private adoptPersistedSessionIfNewer(): void {
        const persisted = this.readPersistedSessionSync();
        if (!persisted || persisted.lastActivityTimestamp <= this.lastActivityTimestamp) {
            return;
        }
        this.sessionId = persisted.sessionId;
        this.adoptSessionNumber(persisted.sessionNumber);
        this.lastActivityTimestamp = persisted.lastActivityTimestamp;
    }

    // Monotonic: session_number never decreases for a client id, so a missing or
    // junk key (parseIntSafe yields 0) must not clobber a known-good value.
    private adoptSessionNumber(candidate: number): void {
        if (candidate > this.sessionNumber) {
            this.sessionNumber = candidate;
        }
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

    // this.sessionNumber++ is only correct because sessionNumber was refreshed
    // immediately before each call site, not read stale. From restoreOrStartSession()
    // it's whatever loadSessionNumber() just read at init(). From ensureSession() it's
    // whatever adoptPersistedSessionIfNewer() just adopted synchronously on the web
    // path — or, on the extension path, whatever the last chrome.storage.onChanged
    // push already landed (a weaker, eventually-consistent guarantee; see
    // registerSessionSyncListener). Easy to "simplify" back into the cross-tab bug
    // from #16 by incrementing a value that was never refreshed.
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

    // Synchronous counterpart to loadSessionState, for the hit path.
    //
    // Returns null on the extension path: chrome.storage is async, so there is
    // nothing to read synchronously there — freshness comes from the
    // chrome.storage.onChanged listener instead.
    private readPersistedSessionSync(): { sessionId: string; sessionNumber: number; lastActivityTimestamp: number } | null {
        if (this.config.isExtension && chrome?.storage?.session) {
            return null;
        }
        const sessionId = localStorage.getItem('ga_session_id');
        const lastActivity = this.parseIntSafe(localStorage.getItem('ga_last_activity'));
        if (!sessionId || lastActivity <= 0) {
            return null;
        }
        return {
            sessionId,
            sessionNumber: this.parseIntSafe(localStorage.getItem('ga_session_number')),
            lastActivityTimestamp: lastActivity
        };
    }

    // The extension counterpart to readPersistedSessionSync: chrome.storage cannot
    // be read synchronously, so instead of polling we let it push. The session id
    // and last-activity live in chrome.storage.session while the session number
    // lives in chrome.storage.local, hence the two areas.
    private registerSessionSyncListener(): void {
        if (!this.config.isExtension || !chrome?.storage?.onChanged) {
            return;
        }
        this.chromeStorageListener = (changes, areaName) => {
            if (areaName === 'session') {
                const id = changes['ga_session_id']?.newValue;
                const activity = this.parseIntSafe(changes['ga_last_activity']?.newValue);
                // Both fields gated on the same freshness signal — Chrome only reports
                // keys that actually changed, so a push carrying ga_session_id without
                // ga_last_activity must not adopt the id on no signal at all, and two
                // contexts rolling in the same second must not each adopt the other's id.
                if (activity > this.lastActivityTimestamp) {
                    if (typeof id === 'string' && id) {
                        this.sessionId = id;
                    }
                    this.lastActivityTimestamp = activity;
                }
                return;
            }
            if (areaName === 'local') {
                const number = changes['ga_session_number']?.newValue;
                if (number !== undefined) {
                    this.adoptSessionNumber(this.parseIntSafe(number));
                }
            }
        };
        chrome.storage.onChanged.addListener(this.chromeStorageListener);
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

    // gtag.js scopes its client ID cookie to the registrable domain; ours lived in
    // origin-scoped localStorage, so a site running both counted one human as two.
    // Preferring the cookie fixes that, and costs nothing where none exists.
    private loadOrCreateClientIdForWeb(): string {
        const source = this.resolveClientIdSource();

        if (source !== 'storage') {
            const fromCookie = this.readGaCookieClientId();
            if (fromCookie) {
                // Not persisted: the cookie is the durable store for an ID we don't
                // own, so deleting _ga resets identity, the same way gtag.js itself
                // mints a fresh client ID once _ga disappears.
                return fromCookie;
            }
        }

        // 'cookie' makes the cookie authoritative: with none present, mint in gtag's
        // shape rather than adopt a legacy UUID, re-identifying that user once —
        // which is why this source is opt-in, not the default.
        if (source === 'cookie') {
            const stored = localStorage.getItem('ga_client_id');
            // Reuse an ID minted on an earlier load, discarding only the legacy UUID
            // this option ignores by design — 'cookie' re-identifies that user once,
            // not on every load, so a cookie write that never lands can't force a remint.
            const clientId = stored && isGtagClientId(stored)
                ? stored
                : mintGtagClientId(Date.now(), this.randomClientIdSeed());
            // Adoption above always returns first, so ga_client_id here is always ours
            // to persist — never an adopted ID.
            this.storeClientId(clientId);
            this.persistGaCookie(clientId);
            return clientId;
        }

        const stored = this.loadOrCreateClientIdFromLocalStorage();
        // The source check is load-bearing: 'storage' means "never touch the cookie",
        // so it has to override writeGaCookie rather than combining with it.
        if (source !== 'storage' && this.config.writeGaCookie) {
            // Write the ID already held, not a fresh mint: re-identifying users is the
            // harm this feature exists to avoid. The _ga payload may end up a UUID
            // instead of gtag's numeric pair, but GA4 accepts any client_id string —
            // and if gtag later rewrites the cookie, our next read adopts it.
            this.persistGaCookie(stored);
        }
        return stored;
    }

    // Validated once here, not trusted verbatim: a typo'd value (e.g. 'Cookie') would
    // otherwise silently degrade to 'auto', including for someone opting out of the cookie.
    private resolveClientIdSource(): 'auto' | 'cookie' | 'storage' {
        const configured = this.config.clientIdSource;
        if (configured === undefined || configured === 'auto' || configured === 'cookie' || configured === 'storage') {
            return configured ?? 'auto';
        }
        console.warn(`[ng-ga4] Unrecognised clientIdSource "${configured}", falling back to "auto".`);
        return 'auto';
    }

    private randomClientIdSeed(): number {
        const buffer = new Uint32Array(1);
        crypto.getRandomValues(buffer);
        // [1, 2^31 - 1], the range gtag draws its first field from.
        return (buffer[0] % 2147483647) + 1;
    }

    private persistGaCookie(clientId: string): void {
        const options = this.resolveCookieOptions();
        // An explicit domain bypasses discovery entirely. Strip any leading dot the
        // caller supplied — the attribute below always adds exactly one — so
        // '.example.com' and 'example.com' behave the same.
        const explicitDomain = options.domain?.replace(/^\.+/, '');
        const { domain, failed } = explicitDomain
            ? { domain: explicitDomain, failed: false }
            : this.discoverCookieDomain();
        if (failed) {
            // Every candidate was refused. A host-only _ga would be worse than none:
            // it diverges per subdomain and can shadow a correctly-scoped cookie
            // already in the jar (from gtag.js, or this library in another tab).
            return;
        }
        const components = domain ? domain.split('.').length : 1;
        const attributes = [
            `path=/`,
            `max-age=${options.maxAgeSeconds}`,
            ...(domain ? [`domain=.${domain}`] : []),
            // Replaces the default SameSite=Lax (and automatic Secure) rather than
            // merging: the caller takes full responsibility for the attribute, e.g.
            // 'SameSite=None; Secure' for a cross-site iframe embed.
            options.flags ?? `SameSite=Lax${this.getProtocol() === 'https:' ? '; Secure' : ''}`
        ];
        // readCookieValue decodes on read, so writing unencoded here is an encode/decode
        // asymmetry — and a clientId containing ";" would inject cookie attributes.
        const value = encodeURIComponent(formatGaCookie(clientId, components));
        this.setCookie(`_ga=${value}; ${attributes.join('; ')}`);
    }

    private resolveCookieOptions(): { domain?: string; flags?: string; maxAgeSeconds: number } {
        const configured = this.config.writeGaCookie;
        const options: NgGa4CookieOptions = typeof configured === 'object' && configured !== null ? configured : {};
        return {
            domain: options.domain,
            flags: options.flags,
            maxAgeSeconds: options.maxAgeSeconds ?? this.GA_COOKIE_MAX_AGE_SECONDS
        };
    }

    // There is no public suffix list in the browser, so the registrable domain must be
    // discovered: trial-set a throwaway cookie at each candidate shortest-first and
    // keep the first that sticks — a browser's refusal on a public suffix is the only
    // oracle available.
    //
    // `domain: null, failed: false` means no domain attribute is wanted (single-label
    // host, IP literal); `failed: true` means every candidate was refused — the caller
    // must not fall back to a host-only cookie then; see persistGaCookie.
    private discoverCookieDomain(): { domain: string | null; failed: boolean } {
        const candidates = registrableDomainCandidates(this.getHostname());
        for (const candidate of candidates) {
            // Per-attempt, not fixed: document.cookie exposes no domain or path, so
            // two tabs probing sibling subdomains concurrently would otherwise clash.
            const probe = `_ng_ga4_probe_${this.randomNonce()}`;
            this.setCookie(`${probe}=1; path=/; domain=.${candidate}`);
            if (readCookieValue(this.getCookieJar(), probe) !== null) {
                this.setCookie(`${probe}=; path=/; domain=.${candidate}; max-age=0`);
                return { domain: candidate, failed: false };
            }
        }
        return { domain: null, failed: candidates.length > 0 };
    }

    private randomNonce(): string {
        const buffer = new Uint32Array(1);
        crypto.getRandomValues(buffer);
        return buffer[0].toString(36);
    }

    private readGaCookieClientId(): string | null {
        // Belt-and-braces, not a full graceful-degradation story: this runs inside
        // init()'s APP_INITIALIZER, where a throw kills bootstrap, but the same
        // sandboxed iframes that deny cookie access typically block localStorage too.
        try {
            const value = readCookieValue(this.getCookieJar(), '_ga');
            return value === null ? null : parseGaCookie(value);
        } catch {
            return null;
        }
    }

    private storeClientId(clientId: string): void {
        localStorage.setItem('ga_client_id', clientId);
    }

    private loadOrCreateClientIdFromLocalStorage(): string {
        let clientId = localStorage.getItem('ga_client_id');
        if (!clientId) {
            // No identity to preserve, so mint in gtag's own shape, not a UUID: gtag
            // accepts this shape rather than rejecting and rewriting it. Also backs
            // loadOrCreateClientIdFromChromeStorage's own fallback when chrome.storage
            // is unavailable, where there's no _ga to align with either way.
            clientId = mintGtagClientId(Date.now(), this.randomClientIdSeed());
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

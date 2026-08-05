import { Inject, Injectable, NgZone, OnDestroy, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { NG_GA4_CONFIG, NgGa4Config, NgGa4CookieOptions } from './ng-ga4.config';
import { ConsentState, Ga4ConsentPayload, NgGa4Consent } from './consent';
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
    private pageshowListener?: () => void;
    private chromeStorageListener?: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;
    // Set by trackPageView(); read by flushEngagement() to attribute the
    // hide-time event's page_location (see flushEngagement for the null case).
    private lastPagePath: string | null = null;
    private device: Ga4Device | null = null;
    private userLocation: Ga4UserLocation | null = null;
    private pendingCalls: Array<() => void> = [];
    private engagement: EngagementTimer | null = null;
    // Resolved once, in init(), by resolveEngagementEventName() — validating on
    // every flush would warn on every window switch for a misconfigured name.
    private engagementEventName = 'page_engagement';
    private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    // Below this, a flush is noise — the time is not discarded, it rides out on
    // the next flush or hit. Blur never reaches this check (see registerEngagementListeners).
    private readonly MIN_ENGAGEMENT_FLUSH_MS = 1000;
    // gtag.js's own default _ga lifetime.
    private readonly GA_COOKIE_MAX_AGE_SECONDS = 63072000;
    private readonly GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
    private readonly GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';
    // Reserved automatically-collected/recommended event names — sending a custom
    // event under one of these is accepted with 2xx and silently dropped.
    private readonly RESERVED_MP_EVENT_NAMES = new Set([
        'user_engagement', 'session_start', 'first_visit', 'first_open', 'error',
        'in_app_purchase', 'os_update', 'app_remove', 'app_update', 'app_clear_data',
        'ad_click', 'ad_impression', 'ad_query', 'ad_exposure', 'adunit_exposure',
        'notification_dismiss', 'notification_foreground', 'notification_open',
        'notification_receive', 'screen_view'
    ]);

    private readonly isBrowser: boolean;
    private readonly consent: ConsentState;
    private enabled: boolean;
    private initPromise: Promise<void> | null = null;
    private storageWrites: Promise<void> = Promise.resolve();

    constructor(
        private http: HttpClient,
        private router: Router,
        private zone: NgZone,
        @Inject(NG_GA4_CONFIG) private config: NgGa4Config,
        @Inject(PLATFORM_ID) platformId: object
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
        this.consent = new ConsentState(config.consent);
        // config.enabled is only the *initial* value now: a consent banner has to be
        // able to turn collection on after the injector is built.
        this.enabled = config.enabled;
    }

    init(): Promise<void> {
        // Every collection path below reads a browser-only global (localStorage,
        // crypto, screen, navigator, window.location), so on the server this must
        // be inert rather than merely quiet — an APP_INITIALIZER that throws takes
        // the whole SSR/prerender bootstrap down with it.
        if (!this.isBrowser || !this.enabled) {
            return Promise.resolve();
        }
        // Memoised rather than guarded by `initialized`: that flag is set
        // synchronously before the first await, so a second caller would resolve
        // while the first is still suspended. setEnabled(true) followed by
        // `await init()` has to await the real thing.
        //
        // A rejection is deliberately NOT memoised. localStorage.setItem throws in
        // Safari private browsing and on quota exhaustion, and caching that would
        // poison the service for its whole lifetime — every later setEnabled(true)
        // would hand back the same rejected promise. Clearing it lets a later call
        // retry.
        return this.initPromise ??= this.runInit().catch(err => {
            this.initPromise = null;
            throw err;
        });
    }

    private async runInit(): Promise<void> {
        this.initialized = true;

        // Created here, not in the constructor: the constructor also runs on
        // the server, where `document` does not exist.
        this.engagement = new EngagementTimer(() => this.monotonicNow(), this.isPageEngaged());
        // Registered before the awaits below: collectContext() awaits
        // getHighEntropyValues(), which a slow browser can hold open for a
        // while, and a blur during that wait would otherwise have no listener
        // to observe it, leaving the timer ticking as "engaged" throughout.
        // flushEngagement() already guards on `!this.clientId`, so it's safe
        // for listeners to be live before clientId is ready.
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
        // Closes the gap between "another context wrote during the awaits above"
        // and "the listener just registered above can observe it" — see
        // catchUpSessionState() for why this can't simply be moved earlier instead.
        await this.catchUpSessionState();

        // Booting denied is not a transition, so setConsent() never fires. Without
        // this, a returning visitor whose app boots denied keeps the identifier
        // written under a previous visit's consent, indefinitely.
        if (!this.consent.storageAllowed) {
            this.clearPersistedIdentity();
        }

        // `await init()` should mean "identity and session state are on disk".
        // On an extension the writes above are queued, not yet landed; on the web
        // this is a resolved promise. Also what keeps specs that assert on mock
        // storage immediately after `await service.init()` honest.
        //
        // init() is an APP_INITIALIZER, so a chrome.storage promise that never
        // settles would stall bootstrap — but loadOrCreateClientIdFromChromeStorage
        // already awaits one above, so this adds no new class of hazard.
        await this.flushStorage();
    }

    /**
     * Update consent at runtime. Merges into the current state — keys you omit are
     * left alone. Call this on every app boot from your own consent store; this
     * library deliberately does not persist consent itself.
     */
    setConsent(consent: NgGa4Consent): void {
        const wasAllowed = this.consent.storageAllowed;
        this.consent.merge(consent);
        const isAllowed = this.consent.storageAllowed;
        if (wasAllowed && !isAllowed) {
            this.clearPersistedIdentity();
            return;
        }
        if (!wasAllowed && isAllowed && this.clientId) {
            this.repersistIdentity(this.clientId);
        }
    }

    /**
     * Turn collection on or off at runtime — the consent-banner switch.
     *
     * Enabling for the first time runs the initialisation that `enabled: false`
     * skipped at bootstrap, so nothing — no client ID, no session, no storage
     * write — exists before this point. `await init()` afterwards if you need to
     * know when it has finished.
     *
     * This is a kill switch, not a consent withdrawal: disabling stops sending but
     * deletes nothing. To remove stored identifiers, deny `analyticsStorage`.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            // Close the interval so the disabled window is not measured. Time
            // accrued before this point was collected under consent and stays in
            // the accumulator to ride out on a later hit.
            this.engagement?.setEngaged(false);
            return;
        }
        if (!this.isBrowser) {
            return;
        }
        // Reopen if the page is currently engaged — the listeners were gated off
        // while disabled, so nothing else will reopen it until the next focus.
        this.setEngagementActive(this.isPageEngaged());
        // Caught, not `void`ed: a storage failure during a late init would
        // otherwise surface as an unhandled promise rejection in the host app.
        this.init().catch(err => console.warn('[ng-ga4] init failed', err));
    }

    /**
     * Resolve once every pending `chrome.storage` write has landed.
     *
     * Await this before an MV3 event handler returns. The service worker can be
     * torn down as soon as the event loop goes idle, and a session or identity
     * write still in flight is simply lost — the next wake reads stale state.
     *
     * Resolves immediately on the web, where storage writes are synchronous.
     *
     * This does not flush *events*: sends are still fire-and-forget (see #26).
     * It is also not a guarantee against forced termination — a browser quit or
     * extension reload can drop an in-flight write whatever we do. For the client
     * ID specifically, `seedNgGa4ClientId()` removes the exposure entirely.
     *
     * The ordering guarantee is per service instance. A background worker and a
     * popup each build their own injector, so each has its own chain, and Chrome
     * still orders their writes against each other however it likes — awaiting
     * this in one context says nothing about writes issued in another.
     */
    async flushStorage(): Promise<void> {
        let tail: Promise<void>;
        // Looped, not a single await: a concurrent trackEvent()/trackPageView()
        // reaches ensureSession() -> saveSessionState() and can enqueue during
        // the await, and returning after only the first tail would drop exactly
        // the write the caller wanted protected. Terminates because nothing here
        // writes in response to a write — there is no path from a settled
        // chrome.storage operation back into enqueueStorageWrite.
        do {
            tail = this.storageWrites;
            await tail;
        } while (tail !== this.storageWrites);
    }

    // Serialises chrome.storage operations: each is chained behind everything
    // already queued, so a write issued earlier can never land after one issued
    // later. That is what makes consent withdrawal's remove() provably final
    // rather than probably final — Chrome documents no ordering guarantee, and
    // clearPersistedIdentity spans two storage areas where none is even implied.
    //
    // Two promises, deliberately. `storageWrites` is the tail flushStorage()
    // awaits and must never reject, or one failed write would poison every flush
    // after it. The returned promise keeps the rejection, for the one caller —
    // the client-ID mint — whose localStorage fallback depends on seeing it.
    // Assigning done.catch(...) to the tail also means `done` always carries a
    // handler, so the call sites that ignore it cannot raise an unhandled
    // rejection.
    //
    // `op` is a thunk, not a promise, so nothing is issued until its turn comes.
    // It may return undefined: clearPersistedIdentity's session remove uses
    // optional chaining, which yields undefined when the area is absent.
    private enqueueStorageWrite(label: string, op: () => Promise<unknown> | undefined): Promise<void> {
        const done = this.storageWrites.then(op).then(() => undefined);
        this.storageWrites = done.catch(err => console.warn(`[ng-ga4] ${label} failed`, err));
        return done;
    }

    // A withdrawal that leaves the identifier on disk is not a withdrawal. Note this
    // ignores provenance: an ID adopted from an existing _ga is deleted too. #13's
    // rule is that we never *write back* an adopted ID; a user withdrawing consent
    // is withdrawing it for the identifier, not for our authorship of it.
    private clearPersistedIdentity(): void {
        if (!this.isBrowser) {
            return;
        }
        if (this.config.isExtension && chrome?.storage) {
            this.enqueueStorageWrite(
                'chrome.storage.local.remove',
                () => chrome.storage.local.remove(['ga_client_id', 'ga_session_number'])
            );
            this.enqueueStorageWrite(
                'chrome.storage.session.remove',
                // Optional chaining yields undefined when the area is absent (MV3
                // exposes chrome.storage.session to trusted contexts only), which
                // enqueueStorageWrite accepts as a no-op link.
                () => chrome.storage.session?.remove(['ga_session_id', 'ga_last_activity'])
            );
            // Deliberately no early return. The *write* paths fall back to
            // localStorage whenever chrome.storage.session is absent (MV3 exposes it
            // to trusted contexts only), and loadOrCreateClientId falls back to
            // localStorage if chrome.storage throws. Removing a key that was never
            // written costs nothing; missing one leaks the whole point of this method.
        }
        localStorage.removeItem('ga_client_id');
        localStorage.removeItem('ga_session_id');
        localStorage.removeItem('ga_last_activity');
        localStorage.removeItem('ga_session_number');
        this.deleteGaCookie();
    }

    private deleteGaCookie(): void {
        // 'storage' is documented as "never touch the cookie". We never read or wrote
        // _ga under it, so deleting it would break an explicit configuration contract
        // to remove something that was never ours.
        if (this.resolveClientIdSource() === 'storage') {
            return;
        }
        const options = this.resolveCookieOptions();
        const explicit = options.domain?.replace(/^\.+/, '');
        // NOT discoverCookieDomain(): that probes by writing cookies. Fanning out
        // across every candidate is both safer and more thorough — deletion is
        // idempotent, cannot create a cookie, and this also clears a host-only _ga
        // that discovery would miss.
        const domains = explicit ? [explicit] : registrableDomainCandidates(this.getHostname());
        // Reuse the caller's flags: a cookie written with 'SameSite=None; Secure'
        // for a cross-site iframe is rejected — and so not deleted — by a write
        // that silently defaults back to SameSite=Lax.
        const flags = options.flags ?? `SameSite=Lax${this.getProtocol() === 'https:' ? '; Secure' : ''}`;
        this.setCookie(`_ga=; path=/; max-age=0; ${flags}`);
        for (const domain of domains) {
            this.setCookie(`_ga=; path=/; max-age=0; domain=.${domain}; ${flags}`);
        }
    }

    // Persists what is already in hand rather than minting: identity continuity
    // across a consent grant is the whole point.
    //
    // storeClientId cannot be used alone here. It writes to localStorage even for
    // extensions, deliberately, because it is the store the chrome.storage failure
    // path falls back to. On re-grant an extension must go back to chrome.storage,
    // or the ID lands somewhere loadOrCreateClientIdFromChromeStorage never reads
    // and the next service-worker start mints a fresh one.
    //
    // Session state goes back too: clearPersistedIdentity removed ga_session_number,
    // and leaving it absent makes the next reload restart the count at 0.
    private repersistIdentity(clientId: string): void {
        if (this.config.isExtension && chrome?.storage) {
            this.enqueueStorageWrite(
                'chrome.storage.local.set (repersist identity)',
                // The inner catch recovers rather than reporting, so it must not
                // propagate: this write failing is precisely when localStorage
                // becomes the store, and a rejection here would be logged twice
                // and recovered once.
                () => chrome.storage.local.set({ ga_client_id: clientId })
                    .catch(err => {
                        console.warn('[ng-ga4] chrome.storage.local.set failed', err);
                        // Same fallback the init path uses when chrome.storage is broken.
                        this.storeClientId(clientId);
                    })
            );
        } else {
            this.storeClientId(clientId);
        }
        this.saveSessionNumber(this.sessionNumber);
        this.saveSessionState();
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
        if (this.pageshowListener && typeof window !== 'undefined') {
            window.removeEventListener('pageshow', this.pageshowListener);
        }
        if (this.chromeStorageListener && chrome?.storage?.onChanged) {
            chrome.storage.onChanged.removeListener(this.chromeStorageListener);
        }
    }

    trackPageView(pagePath: string, pageTitle?: string): void {
        // Dropped, not queued: the server has no client identity to attach a hit to,
        // and replaying queued events after hydration would double-count the view.
        if (!this.isBrowser || !this.enabled) {
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
        if (!this.isBrowser || !this.enabled) {
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
                // Consumed unconditionally, even though ...params below may override what
                // gets reported: a sent hit closes the interval regardless of the value it
                // carries. Skipping this when the caller overrides engagement_time_msec
                // would leave the accumulator open, so the *next* hit reports time since
                // two hits ago instead of one.
                engagement_time_msec: this.consumeEngagementTime(),
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
            consent?: Ga4ConsentPayload;
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
        // Omitted entirely when neither ad signal is set, so GA4 applies the
        // property's own defaults and an install that never calls setConsent()
        // produces a byte-identical request to previous versions.
        const consentPayload = this.consent.toPayload();
        if (consentPayload) {
            body.consent = consentPayload;
        }

        // The validation endpoint records nothing — "events sent to the validation
        // server don't show up in reports" — so it can only ever be a side channel.
        // The real hit below still goes to production, over the configured transport,
        // so debug traffic exercises the same path production will.
        if (this.config.debug) {
            this.sendForValidation(body);
        }

        // forceBeacon is for sends as the page goes away, where XHR would be aborted
        // and the hit lost — losing the event outright is worse than skipping interceptors.
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

    // GA4 counts engagement as time the page is *in focus*, not merely visible;
    // visibilitychange alone would miss a window/app switch that leaves the tab visible.
    private isPageEngaged(): boolean {
        const doc = this.getDocument();
        if (!doc) {
            // No document means no visibilitychange/focus/blur target — nothing
            // could ever close the span, so starting "engaged" would run the
            // clock forever. Narrow in practice, but this library explicitly
            // targets MV3 service workers, which have no document.
            return false;
        }
        const visible = doc.visibilityState !== 'hidden';
        // hasFocus() is unavailable in some embedded contexts; assume focused
        // rather than silently reporting zero engagement everywhere — unlike
        // the missing-document case above, visibilitychange still fires here.
        const focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
        return visible && focused;
    }

    private getDocument(): Document | undefined {
        return typeof document !== 'undefined' ? document : undefined;
    }

    // Date.now() advances while the OS is suspended, so a closed laptop lid would
    // report hours of "engagement" — no blur or visibilitychange fires to close
    // the span while the machine sleeps. performance.now() is monotonic and
    // generally does not advance across suspend; rounded since it's fractional.
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

    // Unreachable today — engagement is constructed before clientId is set —
    // but the fallback exists in case that ordering ever changes.
    private consumeEngagementTime(): number {
        return this.engagement?.consume() ?? 0;
    }

    // Engagement only accrues while collection is enabled. The listeners below stay
    // registered after setEnabled(false), so without this gate a focus or
    // visibilitychange during the disabled window would reopen the interval and the
    // first hit after re-enabling would report time the user spent while collection
    // was supposedly off.
    private setEngagementActive(engaged: boolean): void {
        this.engagement?.setEngaged(engaged && this.enabled);
    }

    private registerEngagementListeners(): void {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
        }
        // init() clears its memoised promise on rejection so a transient storage
        // failure can be retried, which means runInit() can legitimately run more
        // than once. Re-registering would attach a second set of listeners and
        // overwrite the handles ngOnDestroy needs to remove the first — leaking a
        // full set per retry, for the life of the page.
        if (this.visibilityListener) {
            return;
        }
        // init() is an APP_INITIALIZER, which runs inside the Angular zone — with no
        // NgZone escape, zone.js would patch all five handlers below and trigger a
        // full ApplicationRef.tick() on every focus, blur, visibilitychange and
        // pageshow, with a synchronous sendBeacon inside each. Safe to run outside
        // Angular: every handler here only mutates this service's own state and
        // fires a beacon — nothing touches a template or anything change detection cares about.
        this.zone.runOutsideAngular(() => {
            // visibilitychange closes the interval and flushes on disengagement — a
            // hidden tab is a real end of the visit-so-far, worth a network hit.
            this.visibilityListener = () => {
                const engaged = this.isPageEngaged();
                this.setEngagementActive(engaged);
                if (!engaged) {
                    this.flushEngagement();
                }
            };
            // blur stops the clock but deliberately does not flush: sending on every
            // blur would be a network hit per window switch for no extra data. The
            // time is not lost — it stays in the accumulator and rides out on the
            // next hit, or on the eventual hide/pagehide, which still fires on tab close.
            this.blurListener = () => {
                this.setEngagementActive(false);
            };
            // Shared with pageshow below — both just mean "back in front of the
            // user." Never flushes: neither event closes the interval, only opens it.
            const onFocusLike = () => {
                this.setEngagementActive(this.isPageEngaged());
            };
            this.focusListener = onFocusLike;
            // bfcache restore: pagehide closed the interval on the way out; reopening
            // it otherwise depends on visibilitychange or focus firing on the way back
            // in. Not every browser delivers either, in which case the document would
            // silently report zero engagement forever — pageshow is the dedicated signal.
            this.pageshowListener = onFocusLike;
            // Covers cross-document navigation and tab close, where visibilitychange may
            // not fire. unload/beforeunload would be the obvious fallback, but iOS Safari
            // drops those too. setEngaged(false) closes the interval before flushing so a
            // bfcache restore minutes later can't have that dead time recounted.
            this.pagehideListener = () => {
                this.setEngagementActive(false);
                this.flushEngagement();
            };
            document.addEventListener('visibilitychange', this.visibilityListener);
            window.addEventListener('focus', this.focusListener);
            window.addEventListener('blur', this.blurListener);
            window.addEventListener('pageshow', this.pageshowListener);
            window.addEventListener('pagehide', this.pagehideListener);
        });
    }

    // Flushes the trailing chunk of foreground time a page_view-only visit
    // would otherwise never report.
    private flushEngagement(): void {
        // `enabled` is checked here too, not only in track*: this is the fourth
        // sendToGA4 call site and fires from visibilitychange/pagehide listeners
        // that stay registered after setEnabled(false).
        if (!this.enabled || this.config.sendEngagementOnHide === false || !this.clientId) {
            return;
        }
        // Read without draining: below the floor, the time stays in the accumulator
        // and rides out on the next flush or hit. This also deduplicates the
        // visibilitychange/pagehide pair — whichever fires second finds a drained
        // accumulator, reporting 0 via pending(), well below the floor.
        if ((this.engagement?.pending() ?? 0) < this.MIN_ENGAGEMENT_FLUSH_MS) {
            return;
        }
        const engagementTime = this.consumeEngagementTime();
        // Adopt before judging expiry — the in-memory timestamp can go stale while
        // this tab sits idle, and a stale value would wrongly treat a session
        // another tab kept alive as dead.
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
                // Falls back to window.location.href when no page_view has fired yet
                // (or ever will — an extension popup, a non-routed app), so this event
                // is never attributed to siteUrl + '/', a page nobody visited.
                page_location: this.config.siteUrl && this.lastPagePath !== null
                    ? this.joinSiteUrl(this.config.siteUrl, this.lastPagePath)
                    : window.location.href,
                ...(this.config.appVersion ? { app_version: this.config.appVersion } : {})
            }
        }], true);
    }

    // Validated once here, in init(), not in flushEngagement(): a misconfigured
    // name would otherwise warn on every window switch. GA4 returns 2xx and
    // silently drops a hit carrying an invalid or reserved event name — the
    // worst failure mode, since nothing in the response reveals it happened.
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

    // Mirrors the Measurement Protocol's actual event-name naming rules.
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

    // Split out of ensureSession(): the hide-time flush needs to adopt without
    // rolling, deciding expiry against fresh state rather than a timestamp that
    // went stale while this tab sat visible and idle.
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
    // immediately before each call site, not read stale: restoreOrStartSession()
    // just read it via loadSessionNumber(); ensureSession() just adopted it via
    // adoptPersistedSessionIfNewer() (web) or the last chrome.storage.onChanged
    // push (extension — weaker, eventually-consistent; see
    // registerSessionSyncListener). Easy to "simplify" back into the cross-tab
    // bug from #16 by incrementing a value that was never refreshed.
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
        if (!this.consent.storageAllowed) {
            return;
        }
        if (this.config.isExtension && chrome?.storage) {
            this.enqueueStorageWrite(
                'chrome.storage.local.set (session number)',
                () => chrome.storage.local.set({ ga_session_number: sessionNumber.toString() })
            );
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

    // Synchronous counterpart to loadSessionState, for the hit path. Returns null
    // on the extension path: chrome.storage is async, so there is nothing to read
    // synchronously there — freshness comes from the chrome.storage.onChanged
    // listener instead.
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
        // See registerEngagementListeners: runInit() can run again after a retried
        // init, and a second registration would leak this listener too.
        if (this.chromeStorageListener) {
            return;
        }
        this.chromeStorageListener = (changes, areaName) => {
            if (areaName === 'session') {
                const id = changes['ga_session_id']?.newValue;
                const activity = this.parseIntSafe(changes['ga_last_activity']?.newValue);
                // Both fields gated on the same freshness signal — Chrome only reports keys
                // that actually changed, so a push missing ga_last_activity must not adopt
                // the id, and two contexts rolling in the same second must not adopt each other's.
                if (activity > this.lastActivityTimestamp) {
                    if (typeof id === 'string' && id) {
                        this.sessionId = id;
                    }
                    this.lastActivityTimestamp = activity;
                }
                return;
            }
            if (areaName === 'local') {
                // No `!== undefined` guard needed here, unlike 'session' above: a missing
                // key yields 0 from parseIntSafe(), and adoptSessionNumber()'s monotonic
                // guard already no-ops on that, since session numbers only count up from 1.
                this.adoptSessionNumber(this.parseIntSafe(changes['ga_session_number']?.newValue));
            }
        };
        chrome.storage.onChanged.addListener(this.chromeStorageListener);
    }

    // Anything another context wrote during init()'s awaits arrived before the
    // listener existed, and chrome.storage.onChanged does not replay. On the
    // extension path the synchronous read returns null by design, so without this
    // catch-up read a session rolled during that window would be missed entirely
    // — and then overwritten by this instance's next saveSessionState(). The
    // id/timestamp pair and the session number are adopted independently,
    // mirroring registerSessionSyncListener's own 'session' vs 'local' split. Not
    // wrapped in try/catch: loadSessionState() and loadSessionNumber() already
    // catch their own chrome.storage failures and fall back to localStorage.
    private async catchUpSessionState(): Promise<void> {
        const state = await this.loadSessionState();
        if (state && state.lastActivityTimestamp > this.lastActivityTimestamp) {
            this.sessionId = state.sessionId;
            this.lastActivityTimestamp = state.lastActivityTimestamp;
        }
        this.adoptSessionNumber(await this.loadSessionNumber());
    }

    private saveSessionState(): void {
        if (!this.consent.storageAllowed) {
            return;
        }
        if (this.config.isExtension && chrome?.storage?.session) {
            // Captured at enqueue time, not read inside the thunk. The thunk runs
            // later, by which point these fields may already describe a different
            // session — a queued write must persist the state it was issued for.
            const sessionId = this.sessionId;
            const lastActivity = this.lastActivityTimestamp.toString();
            this.enqueueStorageWrite(
                'chrome.storage.session.set',
                () => chrome.storage.session.set({ ga_session_id: sessionId, ga_last_activity: lastActivity })
            );
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
        if (!this.consent.storageAllowed) {
            return;
        }
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

    // Deliberately writes to localStorage even for extensions. This is the store
    // the *fallback* path uses: loadOrCreateClientIdFromChromeStorage drops here
    // when chrome.storage throws, and routing back to chrome.storage would write
    // into the very store that just failed. The extension's own identity write is
    // inline in that method and gated separately.
    private storeClientId(clientId: string): void {
        if (!this.consent.storageAllowed) {
            return;
        }
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
            if (this.consent.storageAllowed) {
                // Enqueued like every other write so a write issued later cannot
                // overtake it, and awaited so a failure reaches the catch below —
                // falling back to localStorage rather than returning an ID that was
                // persisted nowhere. enqueueStorageWrite's returned promise keeps
                // the rejection for exactly this reason.
                //
                // Awaiting does not defeat MV3 teardown: it makes our code wait,
                // not Chrome. seedNgGa4ClientId() is the fix that does — see #32.
                await this.enqueueStorageWrite(
                    'chrome.storage.local.set (mint client id)',
                    () => chrome.storage.local.set({ ga_client_id: clientId })
                );
            }
            return clientId;
        } catch (err) {
            console.warn('[ng-ga4] chrome.storage.local failed, falling back to localStorage', err);
            return this.loadOrCreateClientIdFromLocalStorage();
        }
    }
}

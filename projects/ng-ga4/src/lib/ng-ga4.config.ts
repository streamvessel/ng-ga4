import { InjectionToken } from '@angular/core';

/**
 * Options for the `_ga` cookie this library writes when `writeGaCookie` is
 * truthy. All fields are optional — `{}` writes with every default gtag itself
 * would use.
 */
export interface NgGa4CookieOptions {
    /**
     * Explicit cookie domain, e.g. `'.example.com'`. Skips discovery entirely:
     * no probe cookie is written, and a site whose probes are blocked still gets
     * a correctly-scoped `_ga`. Set this if you know your registrable domain.
     */
    domain?: string;
    /**
     * Cookie attributes replacing the defaults (`SameSite=Lax`, plus `Secure` on
     * HTTPS). For example `'SameSite=None; Secure'` for a cross-site iframe embed.
     */
    flags?: string;
    /** Lifetime in seconds. Defaults to 63072000 — two years, as gtag uses. */
    maxAgeSeconds?: number;
}

export interface NgGa4Config {
    measurementId: string;
    apiSecret: string;
    enabled: boolean;
    isExtension: boolean;
    siteUrl?: string;
    debug?: boolean;
    appVersion?: string;
    /**
     * Network transport for production (non-debug) hits.
     * - 'beacon' (default): navigator.sendBeacon, falling back to fetch(keepalive) then XHR.
     *   Survives page/tab unload, so events fired right before the user leaves are not lost.
     * - 'xhr': Angular HttpClient (XHR). Goes through the app's HTTP interceptors (retry),
     *   but in-flight requests are aborted when the document unloads.
     * Debug mode always uses XHR so the validation response can be read.
     */
    transport?: 'beacon' | 'xhr';
    /**
     * Where the client ID comes from on web. Ignored when `isExtension` is true —
     * there is no `_ga` cookie on a `chrome-extension://` origin.
     *
     * - `'auto'` (default): the `_ga` cookie if present and well-formed, else
     *   this library's own stored ID (minted if none exists yet). An adopted
     *   cookie ID is never persisted — `_ga` remains its only store — so
     *   deleting the cookie falls back to the library's own ID again, the
     *   same way gtag.js itself mints a fresh client ID once `_ga`
     *   disappears. A site also running gtag.js shares one identity with it
     *   for as long as `_ga` exists; removing gtag.js flips returning users
     *   back to their pre-adoption identity, once.
     * - `'cookie'`: `_ga` is authoritative, and one is minted in gtag's format if
     *   absent. Implies `writeGaCookie` — choosing this source is itself the
     *   opt-in to setting a cookie. Note that it deliberately ignores an existing
     *   stored ID, which re-identifies that user once.
     * - `'storage'`: `localStorage` only. The behaviour of every version before
     *   this one.
     */
    clientIdSource?: 'auto' | 'cookie' | 'storage';

    /**
     * Write `_ga` when it is absent or unreadable, on the registrable domain,
     * with gtag's two-year expiry by default. Only that envelope — name, domain, expiry —
     * is gtag's format: the value written is whatever client ID this library
     * already has. A genuinely new install mints one in gtag's own numeric
     * `<random>.<seconds>` shape — there is no identity to preserve there, so
     * no reason to write a shape `gtag.js` might reject and rewrite. An
     * existing user upgrading from a version before this shape change keeps
     * their previously stored `crypto.randomUUID()` as-is; reusing rather
     * than replacing it is deliberate, to avoid re-identifying the user. Off
     * by default: this library does not set a cookie unless asked, which
     * matters because Consent Mode is not implemented yet. Ignored for
     * `'storage'` and for extensions; implied by `'cookie'`.
     *
     * Truthiness governs whether the cookie is written — `{}` writes with all
     * defaults, `false` or omitted writes nothing. Reading `_ga` remains
     * governed by `clientIdSource`; this option only ever controls the write
     * direction, hence the name.
     *
     * An ID adopted from an existing `_ga` cookie is never written back out
     * under this option, no matter how it is configured: doing so would
     * resurrect a cookie a user (or their consent tool) deleted after this
     * library adopted it. This option only ever publishes an ID the library
     * minted itself.
     */
    writeGaCookie?: boolean | NgGa4CookieOptions;

    /**
     * Send an event when the page actually hides (a tab switch or close) or is
     * torn down (`pagehide`), carrying the engagement time accrued since the
     * last hit. Default `true`.
     *
     * Without this, a visit that fires only the initial `page_view` reports ~0 ms
     * of engagement however long the user actually stayed — so it never counts as
     * an engaged session and reads as a bounce. gtag.js sends its own
     * `user_engagement` hit for exactly this reason.
     *
     * Losing focus alone (e.g. alt-tab to another window or application) stops
     * the engagement clock the same way hiding does, but does *not* send this
     * event — only an actual hide (`visibilitychange` to hidden) or `pagehide`
     * does. The accrued time from a mere focus loss is not lost: it stays in
     * the accumulator and rides out on the next hit or the eventual
     * hide/`pagehide`. Sending on every focus loss would mean a network hit
     * per window switch for no extra data. This event always takes the
     * unload-safe transport (`navigator.sendBeacon`, falling back to
     * `fetch(keepalive)` then XHR) regardless of the configured `transport`,
     * since an in-flight XHR is aborted on unload and the hit would simply be
     * lost. A consumer on `transport: 'xhr'` should expect this one event
     * class to bypass their `HttpClient` interceptors.
     */
    sendEngagementOnHide?: boolean;

    /**
     * Event name used for that hide-time event. Default `'page_engagement'`.
     *
     * Validated once, at startup, against the Measurement Protocol's actual
     * naming rules: must start with a letter, contain only letters/digits/
     * underscores, be at most 40 characters, not start with `ga_`, `google_`
     * or `firebase_`, and not be a reserved event name — including but not
     * limited to `user_engagement` (along with `session_start`, `first_visit`
     * and `first_open`), which the Measurement Protocol reserves and rejects.
     * gtag.js is not bound by that because it posts to Google's internal
     * `/g/collect` rather than the Measurement Protocol. GA4 answers `2xx` and
     * silently drops a hit carrying an invalid name, so an invalid or reserved
     * value here logs a console warning once and falls back to the default
     * rather than being sent verbatim. The consequence of choosing a valid,
     * non-reserved name is that ours arrives as an ordinary custom event and
     * appears in Events reports.
     */
    engagementEventName?: string;
}

export const NG_GA4_CONFIG = new InjectionToken<NgGa4Config>('NG_GA4_CONFIG');

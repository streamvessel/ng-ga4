# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `clientIdSource` option, default `'auto'`, to interoperate with gtag.js's
  `_ga` cookie. Previously this library always kept its client ID in
  origin-scoped `localStorage`, so a site running both gtag.js and this
  library counted one human as two users, and `www.`/`app.` subdomains
  diverged where gtag's cookie never did. `'auto'` reads `_ga` when it is
  present and well-formed — the client-ID portion bounded to 64 characters
  of `[A-Za-z0-9._-]`, so a cookie planted by an attacker on a sibling
  subdomain cannot pin every visitor to one ID or inject an oversized value
  into every request — and uses it live, without copying it into
  `localStorage`: `_ga` stays the only durable store for an adopted ID, so
  deleting it resets identity, the same way gtag.js itself mints a fresh
  client ID once `_ga` disappears. On a site running both gtag.js and this
  library, every returning ng-ga4 user is re-identified once as a result,
  merging onto the gtag identity — a real, one-time shift in your user
  counts, worth timing deliberately; removing gtag.js later flips that same
  user back to their pre-adoption identity, once, since the adopted
  identity only ever lived in gtag's cookie. Because reading a cookie
  already on the device is itself a consent-relevant act, not only writing
  one, this happens by default; set `clientIdSource: 'storage'` to stop
  this library from reading `_ga` at all — and since adoption never
  touches `localStorage`, switching to `'storage'` is a true undo, not an
  approximation of one. `clientIdSource: 'cookie'` goes further still: `_ga` is
  authoritative, and a missing cookie is minted rather than adopting
  whatever ID is already stored, re-identifying that user once more. An
  unrecognised `clientIdSource` value now logs a warning and falls back to
  `'auto'` rather than failing silently. Extensions are unaffected — there
  is no `_ga` cookie on a `chrome-extension://` origin.
  ([#13](https://github.com/streamvessel/ng-ga4/issues/13))
- `writeGaCookie` option (default `false`, implied by `clientIdSource:
  'cookie'`) to write `_ga` when it is absent or unreadable. Only the
  envelope — cookie name, registrable domain, gtag's two-year expiry — is
  gtag's format: an existing stored ID is written as-is rather than
  replaced, and only a newly minted ID uses gtag's numeric shape, which
  also gives your own subdomains a shared identity with no gtag.js involved
  at all. The cookie gets `SameSite=Lax`, plus `Secure` on HTTPS, by
  default. It also accepts an `NgGa4CookieOptions` object (`domain`,
  `flags`, `maxAgeSeconds`) in place of `true`: setting `domain` explicitly
  skips the registrable-domain discovery step entirely, so no probe cookie
  is written and a site whose probes would be blocked still gets a
  correctly-scoped cookie. When discovery does run and every candidate
  domain is refused, nothing is written, rather than falling back to a
  host-only cookie that would diverge per subdomain and could collide in
  the jar with a correctly-scoped one. An ID adopted from `_ga` is never
  written back out under this option, in any configuration — doing so would
  resurrect an identifier a user, or their consent tool, had deleted.
  ([#13](https://github.com/streamvessel/ng-ga4/issues/13))
- `sendEngagementOnHide` option, default `true`: sends an event when the page
  hides, carrying the engagement time accrued since the last hit, so a
  single-page visit no longer reports ~0 ms of engagement however long the
  user stayed. Set `false` to opt out.
  ([#15](https://github.com/streamvessel/ng-ga4/issues/15))
- `engagementEventName` option, default `'page_engagement'`, to rename that
  event. Can't be `user_engagement` — the Measurement Protocol reserves it —
  so it appears as an ordinary custom event in Events reports. An invalid or
  reserved name falls back to the default with a console warning.
  ([#15](https://github.com/streamvessel/ng-ga4/issues/15))

### Fixed

- Debug mode records events again. `debug: true` sent every hit to the Measurement
  Protocol validation endpoint, which never records anything, so the
  `debug: !environment.production` pattern the README recommended collected no data
  at all and showed nothing in DebugView. Debug mode now tags each event with
  `debug_mode` and sends the real hit to production, so events appear in DebugView
  *and* in reports. ([#9](https://github.com/streamvessel/ng-ga4/issues/9))
- The library no longer crashes server-side rendering. `init()` runs as an
  `APP_INITIALIZER` and reached for `localStorage`, `crypto`, `window` and `screen`
  with no platform guard, throwing during bootstrap under Angular Universal and
  `ng build --prerender`. It is now inert on the server.
  ([#10](https://github.com/streamvessel/ng-ga4/issues/10))
- `device` fields are populated on browsers without User-Agent Client Hints. Safari
  and Firefox do not implement `navigator.userAgentData`, so their traffic reported no
  browser, operating system or device category, leaving those GA4 dimensions
  `(not set)`. A dependency-free user-agent parser now fills any field Client Hints
  did not supply. ([#11](https://github.com/streamvessel/ng-ga4/issues/11))
- `engagement_time_msec` reflects real engaged time instead of a constant
  `100` on every hit, so **average engagement time** is no longer wrong.
  It does **not** fix engaged sessions, engagement rate or bounce rate: on a
  Measurement-Protocol-only property a custom event carrying
  `engagement_time_msec` raised average engagement time while engaged sessions
  stayed at zero — measured three times over 54 hours, past GA4's full
  processing window, with identical results. See "Engagement measurement" in
  the README and
  [#43](https://github.com/streamvessel/ng-ga4/issues/43).
  ([#14](https://github.com/streamvessel/ng-ga4/issues/14))
- A visit that fires only the initial `page_view` no longer reports ~0 ms of
  engagement however long the user stayed; the trailing time is now flushed on
  hide (see the `sendEngagementOnHide` and `engagementEventName` options above).
  ([#15](https://github.com/streamvessel/ng-ga4/issues/15))
- Two tabs no longer disagree about the session forever. Session state used
  to be cached in memory at `init()`, so once one tab rolled to a new
  session, every other open tab kept sending the dead one indefinitely. Every
  hit now re-reads persisted session state first and adopts anything newer
  (see "Cross-tab session sync" in the README).
  ([#16](https://github.com/streamvessel/ng-ga4/issues/16))

### Changed

- Debug mode sends the real hit over the configured transport instead of always
  forcing XHR, so debug traffic exercises the same delivery path as production.
- Validation responses are reported with `console.warn` only when
  `validationMessages` is non-empty. Previously every response was logged with
  `console.log`, which made a clean payload and a rejected one look alike.
- The `sendEngagementOnHide` event always goes out over the unload-safe
  transport chain (`navigator.sendBeacon`, `fetch(keepalive)`, then XHR)
  regardless of the configured `transport`, since an in-flight XHR is aborted
  on unload. A consumer on `transport: 'xhr'` will find this one event class
  bypassing their `HttpClient` interceptors.

## [0.1.0] - 2026-07-28

### Added

- Initial public release. Extracted from the Stream Vessel frontend, where the
  library has been in production use.
- GA4 Measurement Protocol client with no gtag.js dependency (CSP-compatible).
- Automatic page-view tracking via the Angular Router.
- Session management with a 30-minute inactivity timeout and persistent client ID.
- Chrome extension (MV3) support: `chrome.storage.local` for identity,
  `chrome.storage.session` for session state, with `localStorage` fallback.
- `beacon` and `xhr` transports; debug mode against the GA4 validation endpoint.
- NgModule (`NgGa4Module.forRoot`) and standalone (`provideNgGa4`) APIs.

[0.1.0]: https://github.com/streamvessel/ng-ga4/releases/tag/v0.1.0

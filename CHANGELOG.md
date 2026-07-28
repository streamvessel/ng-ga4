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
  diverged where gtag's cookie never did. `'auto'` now reads `_ga` when it is
  present and well-formed and mirrors it into `localStorage`. On a site
  running both gtag.js and this library, every returning ng-ga4 user is
  re-identified once as a result, merging onto the gtag identity — a
  real, one-time shift in your user counts, worth timing deliberately.
  `'storage'` keeps the previous storage-only mechanism and ignores `_ga`,
  but it is not an undo: once `'auto'` has adopted a cookie ID,
  `localStorage` has already been overwritten. A new `writeGaCookie` option
  (default `false`) opts into writing `_ga` when it is absent — only the
  envelope (cookie name, domain, gtag's two-year expiry) is gtag's format,
  since an existing stored ID is written as-is rather than replaced, and
  only a newly minted ID uses gtag's numeric shape — which also gives your
  own subdomains a shared identity with no gtag.js involved at all.
  `clientIdSource: 'cookie'` implies `writeGaCookie` and deliberately
  ignores any existing stored ID, re-identifying that user once more.
  Extensions are unaffected — there is no `_ga` cookie on a
  `chrome-extension://` origin. ([#13](https://github.com/streamvessel/ng-ga4/issues/13))

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

### Changed

- Debug mode sends the real hit over the configured transport instead of always
  forcing XHR, so debug traffic exercises the same delivery path as production.
- Validation responses are reported with `console.warn` only when
  `validationMessages` is non-empty. Previously every response was logged with
  `console.log`, which made a clean payload and a rejected one look alike.

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

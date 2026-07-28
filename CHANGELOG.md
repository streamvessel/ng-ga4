# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

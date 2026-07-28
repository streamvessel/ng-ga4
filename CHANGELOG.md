# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

# @stream-vessel/ng-ga4

[![npm](https://img.shields.io/npm/v/@stream-vessel/ng-ga4)](https://www.npmjs.com/package/@stream-vessel/ng-ga4)
[![CI](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml/badge.svg)](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Angular library for Google Analytics 4 using the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4). Works in both standard web apps and Chrome extensions (Manifest V3).

Built according to the official [Chrome Extensions GA4 guide](https://developer.chrome.com/docs/extensions/how-to/integrate/google-analytics-4).

## Features

- GA4 Measurement Protocol — no gtag.js or external scripts, CSP-compatible
- Automatic page view tracking via Angular Router
- Session management with 30-minute timeout
- Persistent client ID (survives app restarts)
- Chrome extension support (`chrome.storage.local` for identity, `chrome.storage.session` for sessions)
- Device and browser detection on every browser, not only Chromium
- Debug mode that shows events in GA4 DebugView while still recording them
- SSR-safe — inert on the server, so Universal and prerendering work
- Supports both NgModule and standalone Angular apps

## Installation

```bash
npm install @stream-vessel/ng-ga4
```

## Setup

### Prerequisites

1. A Google Analytics 4 property
2. A Measurement Protocol API secret (Admin > Data Streams > your stream > Measurement Protocol API secrets)

### NgModule apps

```typescript
import { NgGa4Module } from '@stream-vessel/ng-ga4';

@NgModule({
    imports: [
        NgGa4Module.forRoot({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false
        })
    ]
})
export class AppModule {}
```

### Standalone apps

```typescript
import { provideNgGa4 } from '@stream-vessel/ng-ga4';

bootstrapApplication(AppComponent, {
    providers: [
        provideNgGa4({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false
        })
    ]
});
```

## Configuration

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `measurementId` | `string` | Yes | GA4 Measurement ID (e.g. `G-XXXXXXXXX`) |
| `apiSecret` | `string` | Yes | Measurement Protocol API secret |
| `enabled` | `boolean` | Yes | Enable/disable analytics (no-ops when `false`) |
| `isExtension` | `boolean` | Yes | Set `true` for Chrome extensions — uses `chrome.storage` instead of `localStorage` |
| `siteUrl` | `string` | No | Base URL for `page_location` parameter. Required for extensions since `document.location.href` points to `chrome-extension://` |
| `debug` | `boolean` | No | Tag events with `debug_mode` so they appear in GA4 DebugView, and log validation problems to the console. Events are still recorded. |
| `clientIdSource` | `'auto' \| 'cookie' \| 'storage'` | No | Where the client ID comes from on web. `'auto'` (default) reads the `_ga` cookie when present and well-formed, else `localStorage` — set `'storage'` if you don't want this library reading `_ga` at all, since doing so is itself consent-relevant, not only writing one. `'cookie'` treats `_ga` as authoritative and mints one if absent. `'storage'` is the previous behaviour. An unrecognised value logs a console warning and falls back to `'auto'`. Ignored for extensions. |
| `writeGaCookie` | `boolean \| NgGa4CookieOptions` | No | Write `_ga` when absent or unreadable, using the client ID already on hand, on the registrable domain, with `SameSite=Lax` and (on HTTPS) `Secure` by default. Pass `{}` to write with every default, or an `NgGa4CookieOptions` object to override `domain`, `flags`, or `maxAgeSeconds` — see "Interop with gtag.js" below. Off by default. Implied by `clientIdSource: 'cookie'`; ignored for `'storage'` and extensions. |

### Interop with gtag.js

A site that runs both gtag.js and this library used to count one human as two
users: gtag stores its client ID in the `_ga` cookie, scoped to the
registrable domain, while this library kept its own ID in `localStorage`,
scoped to the origin. `www.` and `app.` subdomains diverged from each other
too, which gtag's cookie never did.

`clientIdSource: 'auto'` (the default) fixes this by reading `_ga` when it is
present and well-formed — any well-formed `_ga`, not only one gtag.js wrote;
server-side GA4 tagging and other tools that write the cookie are adopted
the same way. "Well-formed" means the value matches gtag's
`GA<n>.<n>.<clientId>` shape (or a bare `<n>.<n>` pair), with the client-ID
portion bounded to 64 characters of letters, digits, `.`, `_` and `-`;
anything outside that is ignored and the library falls back to
`localStorage` instead. That bound exists because the cookie is not a
trusted input — a sibling subdomain compromised by XSS, or a subdomain
takeover, can set `_ga` too, and an unbounded payload would let that write
pin every visitor to one attacker-chosen ID or inject an oversized value
into every request.

Because gaining access to information already stored on a user's device is
itself a consent-relevant act, distinct from storing it, reading `_ga` this
way happens by default under `clientIdSource: 'auto'` — not only writing
one. Set `clientIdSource: 'storage'` if you need this library to never read
`_ga` at all.

An adopted cookie ID is mirrored into `localStorage`, and the library keeps
using that ID — including as the `client_id` it sends to GA4 — even after
`_ga` is gone. A user, or a consent tool, deleting `_ga` to reset tracking
does not achieve that on its own: the mirrored copy in `localStorage`
survives, and the next page load reads it from there, since this is the
default configuration. What deletion *does* change is whether the cookie
comes back: an ID adopted from `_ga` is recorded as such, and this library
never writes an adopted ID back out, with `writeGaCookie` on or off — so a
deleted `_ga` is not respawned with the same value, it simply is not read
back into the cookie.

`clientIdSource: 'cookie'` goes further: `_ga` is authoritative, and a
missing cookie is minted rather than adopting whatever ID is already in
`localStorage`. That deliberately ignores an existing stored ID, which
re-identifies that user once — a second, opt-in shift in your user counts,
on top of the migration below. Choosing `'cookie'` is itself the opt-in to
writing a cookie: it implies `writeGaCookie`.

`clientIdSource: 'storage'` keeps the previous storage-only mechanism,
ignoring any `_ga` cookie entirely — nothing about it is read, and nothing
is written. That restores the previous *behaviour*, but it is not an undo:
once `'auto'` has adopted a cookie ID it has already overwritten
`localStorage`, so switching to `'storage'` afterwards does not restore the
pre-upgrade identity.

This library does not set `_ga` unless you ask it to. `writeGaCookie: true`
(or an options object — see below) writes it when absent or unreadable, on
the registrable domain, with gtag's two-year expiry — but only that
envelope (cookie name, domain, expiry) is gtag's format. The value written
is whatever client ID the library already has: for an existing user
upgrading, that's this library's own `crypto.randomUUID()`, not gtag's
numeric `<random>.<seconds>` pair. That's deliberate — reusing the existing
ID is what avoids re-identifying the user, which is the harm this feature
exists to prevent in the first place. Only a genuinely new install, with no
stored ID yet, mints a value in gtag's numeric shape. One consequence
follows from that: if `gtag.js` later loads on the same page and rejects
the non-numeric payload, it rewrites the cookie with its own value, and the
next read here adopts that — one further identity flip, then convergence.
As noted above, an ID *adopted from* a cookie is never written back out
under this option, no matter how it is configured.

`writeGaCookie` also accepts an `NgGa4CookieOptions` object (exported from
the public API) in place of `true` — `{}` writes with every default:

- `domain` — an explicit registrable domain, e.g. `'.example.com'`. Setting
  this skips domain discovery (below) entirely, which also means no probe
  cookie is ever written.
- `flags` — cookie attributes replacing the defaults. By default the cookie
  gets `SameSite=Lax`, plus `Secure` when the page is served over HTTPS;
  supplying `flags` (e.g. `'SameSite=None; Secure'` for a cross-site iframe
  embed) replaces both.
- `maxAgeSeconds` — lifetime in seconds. Defaults to gtag's own two years.

Discovering the registrable domain, when `domain` is not given explicitly,
trial-sets a short-lived cookie at each candidate domain, shortest first,
and keeps the first that sticks — relying on the browser's own refusal to
accept a cookie scoped to a public suffix (verified in a real Chromium:
`.uk`, `.gov.uk` and `.github.io` are all refused, while the narrower
host-scoped candidate is accepted). If every candidate is refused, nothing
is written at all: previously the library fell back to a host-only cookie
in that case, but a host-only `_ga` diverges per subdomain and can sit in
the jar under the same name as a correctly-scoped one, so that fallback is
gone. A single-label host like `localhost` is not a failure case — it gets
a host-only cookie, since there is no domain to scope to in the first
place.

Setting `writeGaCookie: { domain: '.example.com' }` is the way to avoid the
probe cookie altogether. Where you cannot supply a domain and discovery
runs, be aware the probe is named `_ng_ga4_probe_<random>`, a fresh name on
every attempt — worth knowing if you maintain a cookie declaration for a
consent management platform, which typically wants a fixed name to declare.

[Consent Mode](https://github.com/streamvessel/ng-ga4/issues/20) is not
implemented yet. If you need consent before this library touches `_ga`,
there are two things to gate on: writing and reading. Gate `writeGaCookie`
(and `clientIdSource: 'cookie'`, which implies it) behind your own consent
state to control writing; set `clientIdSource: 'storage'` until consent is
granted to stop this library from reading an existing `_ga` cookie too —
reading counts here as much as writing does.

**Migration:** upgrading with both gtag.js and this library present will
re-identify each returning ng-ga4 user once, merging them onto the gtag
identity. This is the fix working as intended, but it is a real,
one-time shift in your user counts — worth timing deliberately.

## Usage

### Automatic page views

Page views are tracked automatically on every Angular Router `NavigationEnd` event. No additional code needed.

### Custom events

```typescript
import { NgGa4Service } from '@stream-vessel/ng-ga4';

@Component({ ... })
export class MyComponent {
    constructor(private analytics: NgGa4Service) {}

    onLogin() {
        this.analytics.trackEvent('login', { method: 'google' });
    }
}
```

### Manual page views

```typescript
this.analytics.trackPageView('/custom-page', 'Custom Page Title');
```

## API

### `NgGa4Service`

| Method | Description |
|--------|-------------|
| `init(): Promise<void>` | Initialize analytics. Called automatically via `APP_INITIALIZER`. |
| `trackPageView(pagePath: string, pageTitle?: string): void` | Track a page view. Called automatically on router navigation. |
| `trackEvent(name: string, params?: Record<string, any>): void` | Track a custom event. |

All methods are no-ops when `enabled` is `false` or before initialization.

## Chrome Extension Setup

1. Add `"storage"` to your `manifest.json` permissions:

```json
{
    "permissions": ["storage"]
}
```

2. Ensure your CSP allows the extension to make requests (the default `script-src 'self'` is fine — no external scripts are loaded):

```json
{
    "content_security_policy": {
        "extension_pages": "script-src 'self'; object-src 'self'"
    }
}
```

3. Set `isExtension: true` and provide a `siteUrl`:

```typescript
NgGa4Module.forRoot({
    measurementId: 'G-XXXXXXXXX',
    apiSecret: 'your-api-secret',
    enabled: true,
    isExtension: true,
    siteUrl: 'https://your-extension-domain.com'
})
```

### Storage strategy

| Data | Web | Extension |
|------|-----|-----------|
| Client ID | `_ga` cookie when present and well-formed (default), else `localStorage`; writing to the cookie is opt-in (see "Interop with gtag.js" above) | `chrome.storage.local` |
| Session number | `localStorage` | `chrome.storage.local` |
| Session ID + activity | `localStorage` | `chrome.storage.session` |

## Server-side rendering

Safe to include in an Angular Universal or prerendered app with no extra configuration. The service detects a non-browser platform via `PLATFORM_ID` and goes inert: `init()` touches no storage, and `trackEvent`/`trackPageView` are no-ops.

Server-side calls are dropped rather than queued for replay. The server has no client identity to attach a hit to, and replaying on hydration would double-count the page view — the browser sends its own once the app boots.

## Device detection

GA4's Measurement Protocol does not infer anything from the `User-Agent` request header, so the library sends a `device` object explicitly.

Where [User-Agent Client Hints](https://developer.mozilla.org/en-US/docs/Web/API/User-Agent_Client_Hints_API) are available (Chromium), those are used. Safari and Firefox do not implement them, so a built-in user-agent parser fills in browser, browser version, operating system, OS version and device category. Client Hints always win where present; the parser only fills fields they did not supply, which also covers Chromium installs where high-entropy hints are refused.

## Debug Mode

Set `debug: true` to tag every event with `debug_mode`, which makes it show up in [DebugView](https://support.google.com/analytics/answer/7201382) in the GA4 UI.

**Events are still recorded normally.** Debug mode changes what GA4 shows you, not whether the data counts — hits go to the production endpoint over your configured transport, so debug traffic exercises the same delivery path production will.

Alongside each hit, the same payload is posted to the [validation endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events), and anything it objects to is logged with `console.warn`. A clean payload logs nothing. The validation endpoint is only ever a side channel: events sent there are never recorded, which is why the real hit goes out separately.

```typescript
NgGa4Module.forRoot({
    ...config,
    debug: !environment.production
})
```

## Security notes

The API secret is visible to anyone who inspects the built bundle. This is inherent to Measurement Protocol from the browser — the client needs the secret to authenticate. Google follows the same pattern in its Chrome Extensions GA4 guide.

Impact is bounded:
- An extracted secret only lets an attacker send fake events to your property (polluting data and consuming quota).
- It grants no read access to your analytics.

Mitigation: watch your GA4 property for unusual event volume. If abuse shows up, rotate the secret (Admin → Data Streams → your stream → Measurement Protocol API secrets → delete + create), then redeploy the client with the new value.

## Peer Dependencies

- `@angular/core` ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0
- `@angular/common` ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0
- `@angular/router` ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0
- `rxjs` ^7.0.0

**Angular version support:** the peer range above is permissive, but CI tests
against Angular 18 only. Reports of breakage on other majors are welcome.

## Local development

```bash
pnpm install
pnpm run build    # ng-packagr build into dist/ng-ga4
pnpm test         # Karma/Jasmine, headless Chrome
pnpm run lint
```

To try an unreleased change in a consuming app without publishing:

```bash
# in this repo
pnpm run build
# in the consuming app
pnpm add file:../ng-ga4/dist/ng-ga4
```

Remember to restore the registry version (`pnpm add @stream-vessel/ng-ga4@latest`)
before committing the consuming app.

## License

Apache-2.0 — see [LICENSE](../../LICENSE).

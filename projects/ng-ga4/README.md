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
| `sendEngagementOnHide` | `boolean` | No | Send an event when the page hides (or is torn down via `pagehide`), carrying the engagement time accrued since the last hit — without it, a visit that only fires the initial `page_view` reports ~0 ms of engagement however long the user actually stayed, and reads as a bounce. Losing focus alone (e.g. an alt-tab) stops the clock the same way but does not trigger this event; see "Engagement measurement" below. Default `true`. |
| `engagementEventName` | `string` | No | Event name for the hide-time event above. Default `'page_engagement'`. Validated once at startup against the Measurement Protocol's actual naming rules — see "Engagement measurement" below — since GA4 answers `2xx` and silently drops a hit with an invalid name. Can't be `user_engagement` — the Measurement Protocol reserves that name — so it arrives as an ordinary custom event and appears in Events reports. An invalid or reserved name logs a console warning once and falls back to the default. |

### Engagement measurement

`engagement_time_msec` drives GA4's average engagement time, engaged
sessions, engagement rate and, by extension, bounce rate. This library
measures real engaged time between hits: each `page_view` or custom event
reports the time elapsed since the previous hit, not a running total —
the same interval gtag.js tracks as `_et`.

Time only accrues while the page is both visible *and* focused, matching
how GA4 itself defines user engagement: "the amount of time someone
spends with your web page in focus." Switching tabs, switching to another
window or application, and minimising the browser all stop the clock —
even a window switch that leaves this tab visible in the background, which
`visibilitychange` alone would never catch. Switching back to the tab and
refocusing it resumes accumulation.

A visit that only fires the initial `page_view` would otherwise report
almost no engagement time, however long the user stayed, and read as a
bounce. `sendEngagementOnHide` (default `true`) sends an event when the
page actually hides (a tab switch or close) or is torn down (`pagehide`),
carrying the time since the last hit; `false` opts out, at the cost of
under-reporting engagement. Losing focus alone — an alt-tab to another
window or application — stops the clock the same way hiding does, but does
**not** send anything: the accrued time simply stays in the accumulator
and rides out on the next real hit, or on the eventual hide/`pagehide`,
which still fires on tab close. Sending on every loss of focus would mean
a network hit per window switch for no extra data — ten alt-tab cycles
would otherwise be ten hits. A flush that does fire is additionally
floored at about a second of accrued time and silently skipped below it,
so a burst of rapid hide/show cycles doesn't emit an event per cycle
either; as above, that time is never discarded, only deferred to the next
flush or hit. That event can't be named `user_engagement` — the
Measurement Protocol reserves that name, and gtag.js is exempt only
because it posts to Google's internal `/g/collect` endpoint, not the
Measurement Protocol — so it ships as an ordinary custom event,
`engagementEventName`, default `'page_engagement'`, validated once at
startup against the Measurement Protocol's actual naming rules (must start
with a letter, letters/digits/underscores only, at most 40 characters, not
one of the `ga_`/`google_`/`firebase_` prefixes, and not a reserved event
name); an invalid or reserved name logs a console warning once and falls
back to the default. It always takes the unload-safe transport path
regardless of the configured `transport` — `navigator.sendBeacon`, falling
back to `fetch(keepalive)` and only then to XHR — because an in-flight XHR
is aborted on unload and the hit would simply be lost.

Inside an unfocused iframe, `document.hasFocus()` is `false` even while the
embed is fully visible and being read, so an embedded app a user looks at but
never clicks into accrues zero engagement time. That is correct per GA4's own
"in focus" definition, but it is a real change in direction for consumers who
embed this library in an iframe and expect scroll or dwell time alone to
count.

Any flush — the hide event above, or an ordinary hit — also calls the same
session-freshness logic as every other hit, which extends a live GA4
session. In practice that means a tab left open and merely alt-tabbed between
keeps its session alive indefinitely, where previously it would expire after
30 minutes with no hits at all. This matches gtag.js, where any hit extends a
session, but it is a real change in your session counts that is not
documented anywhere else. One exception: a flush that fires *after* the
session has already timed out attributes its trailing time to that expired
session rather than rolling a new one — landing the trailing time on a
session with no page view, and bumping session_number for a session that
never really happened, is worse — so GA4 will show that particular session
running longer than 30 minutes.

Expect these numbers to trend close to, not match exactly, a property also
measured by gtag.js. This library measures visible-*and*-focused time, per
GA4's own definition of engagement. gtag.js is closed-source, but public
observation of its behaviour suggests it keys off Page Visibility alone and
does not install focus/blur handlers of its own — if that holds, a property
instrumented with gtag.js would not stop its clock on a window switch the
way this library does, which would make this library read systematically
*lower*, particularly on multi-monitor and side-by-side-window setups. That
is not a guarantee, only the likely shape of any gap, alongside the reserved
`user_engagement` event name above being out of reach for this library
either way.

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

An adopted cookie ID is used but never persisted — `_ga` remains its only
store. Deleting `_ga` therefore resets identity: the library falls back to
its own stored ID, minting one if it doesn't have one yet, the same way
gtag.js mints a fresh client ID once `_ga` disappears. A site that later
removes gtag.js flips its returning users back to their pre-adoption
identity, once — an accepted cost, not a bug, since that identity always
lived in gtag's cookie and never in anything this library stored (which
also means there is no adopted third-party identifier sitting in storage
for a consent tool to miss). With `writeGaCookie` on, a deleted `_ga` does
come back, but carrying a freshly minted ID rather than the one that was
deleted — the library is minting a new identity, not respawning the old
one.

`clientIdSource: 'cookie'` goes further: `_ga` is authoritative, and a
missing cookie is minted rather than adopting whatever ID is already in
`localStorage`. That deliberately ignores an existing stored ID, which
re-identifies that user once — a second, opt-in shift in your user counts,
on top of the migration below. Choosing `'cookie'` is itself the opt-in to
writing a cookie: it implies `writeGaCookie`.

`clientIdSource: 'storage'` keeps the previous storage-only mechanism,
ignoring any `_ga` cookie entirely — nothing about it is read, and nothing
is written. Because an adopted cookie ID is never persisted, switching to
`'storage'` is a true undo: it returns to whatever ID was already in
`localStorage` before `'auto'` ever ran, or mints a fresh one if there
never was one.

This library does not set `_ga` unless you ask it to. `writeGaCookie: true`
(or an options object — see below) writes it when absent or unreadable, on
the registrable domain, with gtag's two-year expiry. The value written is
whatever client ID the library already has: for an existing user upgrading
from a version before this shape change, that's a previously stored
`crypto.randomUUID()`, reused as-is rather than replaced — deliberately,
since reusing the existing ID is what avoids re-identifying the user, the
harm this feature exists to prevent in the first place. A genuinely new
install, with no stored ID yet, mints a value in gtag's own numeric
`<random>.<seconds>` shape instead of a UUID: there is no identity to
preserve there, so there is no reason to write a shape `gtag.js` might
reject and rewrite. One consequence follows from that for the upgrading
case above: if `gtag.js` later loads on the same page and rejects a
carried-over UUID, it rewrites the cookie with its own value, and the next
read here adopts that — one further identity flip, then convergence. As
noted above, an ID *adopted from* a cookie is never written back out under
this option, no matter how it is configured.

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

### Cross-tab session sync

Session state used to be read once at `init()` and cached in memory, so once
one tab rolled to a new session, every other open tab kept sending the dead
one indefinitely. Every hit path now re-reads persisted session state first
and adopts it if it is newer before deciding whether to roll. On web that
re-read is synchronous, straight from `localStorage`. On extensions,
`chrome.storage` cannot be read synchronously, so freshness instead comes
from a `chrome.storage.onChanged` listener that adopts session ID and
activity from the `session` storage area and session number from `local` as
they change. Session number itself only ever increases for a given client
ID, never decreases, so a stale or missing read can't roll it backwards.

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

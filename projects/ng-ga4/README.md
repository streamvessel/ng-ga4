# @stream-vessel/ng-ga4

[![npm](https://img.shields.io/npm/v/@stream-vessel/ng-ga4)](https://www.npmjs.com/package/@stream-vessel/ng-ga4)
[![CI](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml/badge.svg)](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/streamvessel/ng-ga4/blob/master/LICENSE)

Google Analytics 4 for Angular over the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4). It loads no remote script, so it works under a strict CSP and in Chrome extensions (Manifest V3), following Google's [Chrome Extensions GA4 guide](https://developer.chrome.com/docs/extensions/how-to/integrate/google-analytics-4).

Used in production in the [Stream Vessel](https://streamvessel.com) Chrome extension.

## Features

- No `gtag.js` and no external scripts
- Automatic page views from the Angular Router
- Persistent client ID and 30-minute sessions, kept in step across tabs
- User-ID for cross-device reporting (`setUserId()`)
- Real engagement time: visible and focused time since the last hit
- Chrome extension support (`chrome.storage`), including MV3 service-worker teardown
- Shares the `_ga` client ID with `gtag.js` when both run on a site
- Consent Mode (`ad_user_data`, `ad_personalization`) and a storage-consent switch
- User properties, kept across reloads
- Device and browser detection on every browser, not only Chromium
- Debug mode that shows events in DebugView and still records them
- Safe under SSR; works with NgModule and standalone apps

## What you give up

This library sends data to GA4 straight from your code, without Google's tracking script (`gtag.js`). That is why it works where the script can't, but GA4 learns less about each visit, so some reports stay empty:

- **Where visitors came from:** every visit shows as "direct", with no search, link or campaign data.
- **New users:** always 0.
- **Engaged sessions, engagement rate and bounce rate:** always 0, so you can't use them.
- **Age, gender, interests, and Google Ads remarketing:** no data.
- **City and region:** no data. The country still shows, guessed from the browser's time zone.

These work as usual: events, page views, active users and average engagement time.

We checked all of this on a real GA4 property; [LIMITATIONS.md](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/LIMITATIONS.md) has the details.

**If your app can load Google's script, use `gtag.js` instead.** This library is for when it can't.

## Install

```bash
npm install @stream-vessel/ng-ga4
```

You need a GA4 property and a Measurement Protocol API secret (Admin → Data Streams → your stream → Measurement Protocol API secrets).

**NgModule apps**

```typescript
import { NgGa4Module } from '@stream-vessel/ng-ga4';

@NgModule({
    imports: [
        NgGa4Module.forRoot({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false,
        }),
    ],
})
export class AppModule {}
```

**Standalone apps**

```typescript
import { provideNgGa4 } from '@stream-vessel/ng-ga4';

bootstrapApplication(AppComponent, {
    providers: [
        provideNgGa4({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false,
        }),
    ],
});
```

## Configuration

**Required**

- `measurementId` (`string`): GA4 Measurement ID, e.g. `G-XXXXXXXXX`.
- `apiSecret` (`string`): Measurement Protocol API secret.
- `enabled` (`boolean`): whether collection starts on. `false` creates no client ID and writes nothing until `setEnabled(true)`. See [Consent](#consent).
- `isExtension` (`boolean`): `true` in a Chrome extension, so state goes to `chrome.storage` instead of `localStorage`.

**Optional**

- `siteUrl` (`string`): base of `page_location`, e.g. `https://example.com`. Needed in extensions, where the page address is `chrome-extension://…`. Without it, `page_location` is the page's full address.
- `appVersion` (`string`): sent as `app_version` on every event.
- `transport` (`'beacon' | 'xhr'`, default `'beacon'`): `'beacon'` tries `sendBeacon`, then `fetch` with `keepalive`, then XHR, so hits survive the page closing. `'xhr'` sends through `HttpClient` and your interceptors, but a request still in flight when the page closes is lost.
- `debug` (`boolean`, default `false`): see [Debug mode](#debug-mode).
- `clientIdSource` (`'auto' | 'cookie' | 'storage'`, default `'auto'`): where the web client ID comes from. See [Client ID and gtag.js](#client-id-and-gtagjs). An unknown value logs a warning and falls back to `'auto'`, which reads `_ga`. Ignored in extensions.
- `writeGaCookie` (`boolean` or `NgGa4CookieOptions`, default `false`): write a `_ga` cookie when there is no valid one (web only). See [Client ID and gtag.js](#client-id-and-gtagjs).
- `sendEngagementOnHide` (`boolean`, default `true`): send the engagement time left over when the page is hidden or closed. See [Engagement time](#engagement-time).
- `engagementEventName` (`string`, default `'page_engagement'`): name of that event. An invalid or reserved name (such as `user_engagement`) logs a warning and falls back to the default.
- `consent` (`NgGa4Consent`, default: storage granted): initial consent state. See [Consent](#consent).

## Usage

Page views are sent on every Router `NavigationEnd`; you don't need to write anything for them.

```typescript
import { NgGa4Service } from '@stream-vessel/ng-ga4';

export class MyComponent {
    constructor(private analytics: NgGa4Service) {}

    onLogin() {
        this.analytics.trackEvent('login', { method: 'google' });
    }

    onCustomView() {
        this.analytics.trackPageView('/custom-page', 'Custom Page Title');
    }
}
```

### API

| `NgGa4Service` method | Description |
|---|---|
| `trackEvent(name, params?)` | Send a custom event. Checked against GA4's naming rules first; see [Event validation](#event-validation). |
| `trackPageView(path, title?)` | Send a page view. Called for you on navigation. |
| `setUserId(userId)` | Send `user_id` on every hit from now on; `null` on sign-out. See [User ID](#user-id). |
| `setUserProperties(properties)` | Set user properties, sent with every later hit. See [User properties](#user-properties). |
| `setConsent(consent)` | Update consent. Keys you leave out stay as they are. |
| `setEnabled(enabled)` | Turn collection on or off. The first `true` runs the initialisation that `enabled: false` skipped. |
| `flushStorage()` | Resolves once pending `chrome.storage` writes have landed. Resolves at once on the web. |
| `init()` | Starts the library. Runs for you at app start. |

Calls made while collection is off are dropped. Calls made after `init()` has started but before it finishes are queued and sent once it does; calls made before it starts (for example from an earlier `APP_INITIALIZER`) are dropped.

Also exported: `seedNgGa4ClientId()` (see [Chrome extensions](#chrome-extensions)), `NgGa4Config`, `NgGa4CookieOptions`, `NgGa4Consent`, `NgGa4ConsentState`, `NgGa4UserPropertyValue` and `NG_GA4_CONFIG`.

### Event validation

GA4's `/mp/collect` answers `204` even for an event it is about to discard, so a typo in an event name would otherwise lose that data without a trace. `trackEvent()` checks each event against the [Measurement Protocol's rules](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#reserved_names) before sending it:

- **Event name:** at most 40 characters; starts with a letter; only letters (any script, so `café` and `購入` are fine), digits and underscores; not reserved (`session_start`, `first_visit`, `user_engagement`, `error`, `notification_open` and the rest of Google's list, or a `_`, `firebase_`, `ga_`, `google_` or `gtag.` prefix). An event that breaks one of these is **not sent**.
- **Parameter name:** at most 40 characters, same characters, not `firebase_conversion` and none of the prefixes above. A parameter that breaks one of these is **removed**; the rest of the event is sent.
- **Warnings only, sent unchanged:** App-stream event names (`ad_impression`, `in_app_purchase`, `screen_view`); string values over 100 characters (1000 for `page_location`, 420 for `page_referrer`, 300 for `page_title`), since GA4 360 properties allow 500; and events with more than 25 parameters, counting the ones the library adds except `debug_mode`.

In development (`isDevMode()`) or with `debug: true`, each problem is logged with `console.warn`, naming the event and the rule. In a production build without `debug`, invalid events and parameters are still dropped, silently.

## User ID

Call `setUserId()` when a user signs in, and `setUserId(null)` when they sign out. Every hit after that carries a top-level `user_id`, the same as `gtag('config', 'G-XXXXXXXXX', { user_id })`, so GA4 can join one person across devices and platforms.

```typescript
onSignIn(user: User) {
    this.analytics.setUserId(user.id);
}

onSignOut() {
    this.analytics.setUserId(null);
}
```

- Use your own opaque ID, at most 256 characters. Never send an email address or other personal data. A longer value, or one that isn't a string, logs a warning and clears the user ID.
- The ID is stored next to the client ID (`localStorage`, or `chrome.storage.local` in an extension) and comes back on the next load, so you don't need to set it again on every start-up. An empty string counts as `null`.
- It is always the top-level field, never a user property: `user_id` is a reserved user property name.
- Calling it before collection starts is fine; it is stored once `init()` runs. With `analyticsStorage` denied, an ID you set is sent but not stored; a stored one is deleted, and not sent, also on a start-up that begins denied.
- Each tab or extension context keeps its own copy until its next load, so sign out in every context that is open.

## User properties

The equivalent of `gtag('set', 'user_properties', { ... })`:

```typescript
this.analytics.setUserProperties({ plan: 'pro', seats: 5 });
this.analytics.setUserProperties({ seats: null });  // remove one
this.analytics.setUserProperties(null);             // remove all
```

- Each call merges into what is already set. `null` removes a property; `undefined` leaves it as it is, so `{ plan: user?.plan }` before the user has loaded doesn't delete a stored plan. They go out as `user_properties` on every later hit, including page views and the hide-time engagement event.
- They are stored next to the client ID, so they survive a reload, and are deleted with it when `analyticsStorage` is denied (see [Consent](#consent)). Each call merges onto what other tabs or extension contexts have stored, so one never wipes another's properties; a tab still sends its own copy on hits until its next call or reload.
- Calls made before `init()` has finished, including while collection is off before it first runs, are applied once it does. After that, calls are stored at once even while collection is off, as `setUserId()` does. On the server the call does nothing.
- Anything GA4 would reject is dropped, with a console warning in dev mode: more than 25 properties (those already set win), a name longer than 24 characters or not made of letters, digits and underscores, a value longer than 36 characters (counted as characters, so an emoji is one), the reserved names `first_open_time`, `first_visit_time`, `last_deep_link_referrer`, `user_id` and `first_open_after_install`, and names starting with `_`, `ga_`, `google_` or `firebase_` in any letter case.
- To see a property in reports, register it in GA4 as a user-scoped custom dimension.

## Engagement time

Every hit carries `engagement_time_msec`: the time since the previous hit during which the page was visible **and** focused, the same interval `gtag.js` measures.

- Switching tabs, windows or apps, or minimising the browser, stops the clock. Coming back starts it again.
- Focus inside a child frame (an `iframe`, an embedded viewer) doesn't count.
- If your app itself runs inside another page's iframe, it only counts while that iframe has focus, so a reader who never clicks into it reports no engagement.
- Losing focus sends nothing; the time rides on the next hit.
- When the page is hidden or closed, the time left over goes out as one `page_engagement` event (see `sendEngagementOnHide`), always over the unload-safe transport. That event waits until at least 1 second has built up; anything shorter rides on the next hit. Its `page_location` is the last path you reported in a page view; with `siteUrl` set and no page view yet, it has none, so the raw page address (and anything in its query) never goes out. Without this event, a visit with a single page view would report almost no engagement.

This feeds GA4's **average engagement time**. It does **not** make sessions count as engaged, so engaged sessions, engagement rate and bounce rate stay unusable ([#43](https://github.com/streamvessel/ng-ga4/issues/43)). Expect the numbers to come out close to `gtag.js`'s, possibly a little lower, since this library also stops the clock when the window loses focus.

## Client ID and gtag.js

On the web the client ID comes from `clientIdSource`:

- **`'auto'`** (default): use the `_ga` cookie when it is present and well formed, else this library's own ID in `localStorage`. A site running both `gtag.js` and this library counts each person once, across subdomains too. The adopted ID is never copied into storage, so deleting `_ga` returns to the library's own ID.
- **`'cookie'`**: `_ga` is the only source. One is created if missing (this implies `writeGaCookie`), reusing an ID already stored in `gtag.js`'s format. An older UUID-style ID is replaced, so those users are counted as new once.
- **`'storage'`**: `localStorage` only. `_ga` is never read or written.

Reading an existing cookie is itself a consent-relevant act. Use `'storage'` if this library must never read `_ga`.

A `_ga` value is accepted only in `gtag.js`'s own format, with an ID of at most 64 characters (letters, digits, `.`, `_`, `-`). Anything else is ignored. This keeps out malformed and oversized values; it can't tell a well-formed cookie planted from another subdomain from a real one.

**`writeGaCookie`** writes `_ga` when there is none or it fails the check above, using the library's own ID, on the registrable domain, with `SameSite=Lax`, `Secure` on HTTPS and `gtag.js`'s two-year expiry. An ID adopted from a cookie is never written back. Pass `NgGa4CookieOptions` to change the defaults:

- `domain`: e.g. `'.example.com'`. Without it, the library finds the registrable domain by setting a short-lived probe cookie (`_ng_ga4_probe_<random>`) at each candidate and keeping the first the browser accepts. If the browser refuses every candidate, no `_ga` is written at all; a single-label host such as `localhost` gets a host-only cookie. Set `domain` to skip the probe, for instance if a consent platform needs a fixed list of cookie names.
- `flags`: replaces the default attributes, e.g. `'SameSite=None; Secure'` for a cross-site iframe.
- `maxAgeSeconds`: lifetime, two years by default.

**Upgrading** a site that also runs `gtag.js` moves each returning user onto the `gtag.js` identity, once. That is a one-off jump in user counts; plan when you ship it.

## Consent

With no `consent` option and no `setConsent()` call, nothing changes: no `consent` field is sent, and GA4 applies your property's defaults.

For a consent banner, start disabled and enable when the user accepts:

```typescript
// In your providers: no client ID is created and nothing is stored yet.
provideNgGa4({ measurementId: 'G-XXXXXXXXX', apiSecret: 'your-api-secret', enabled: false, isExtension: false })

// In your consent banner component:
constructor(private ga4: NgGa4Service) {}

onBannerAccepted(): void {
    this.ga4.setConsent({ analyticsStorage: 'granted', adUserData: 'granted', adPersonalization: 'denied' });
    this.ga4.setEnabled(true);
}
```

Events fired while disabled are dropped, not queued, so the first page view before consent is lost. That is on purpose.

| Signal | Sent to GA4 | Effect |
|---|---|---|
| `adUserData` | as `consent.ad_user_data` | GA4 acts on it |
| `adPersonalization` | as `consent.ad_personalization` | GA4 acts on it |
| `analyticsStorage` | no | Whether this library stores identifiers |

Denying `analyticsStorage` stops every write to `localStorage`, `chrome.storage` and `_ga`, and deletes what is already stored (the user ID too), also on a start-up that begins denied. Collection continues with an ID held in memory, so each page load is a new user and session. Under `'storage'` the cookie is left alone; where `gtag.js` also runs, it writes `_ga` again on its next hit.

Things to know:

- **This library doesn't store consent, and each tab or extension context has its own.** Call `setConsent()` on every start-up from your own record of the user's choice, in every context. A tab that is still granted keeps writing session data to the shared store after another tab denies.
- **`setEnabled(false)` stops sending but deletes nothing.** To remove stored identifiers, deny `analyticsStorage`.
- **Granting again restores the client ID, user ID and session at once, but `_ga` only on the next page load.**
- An invalid consent value counts as `denied`, with a warning.

## Chrome extensions

1. Add the `storage` permission to `manifest.json`: `"permissions": ["storage"]`. The default extension CSP is fine, since no remote script is loaded.
2. Set `isExtension: true` and a `siteUrl`:

```typescript
NgGa4Module.forRoot({
    measurementId: 'G-XXXXXXXXX',
    apiSecret: 'your-api-secret',
    enabled: true,
    isExtension: true,
    siteUrl: 'https://your-extension-domain.com',
});
```

| Data | Web | Extension |
|---|---|---|
| Client ID | `_ga` if present (default), else `localStorage` | `chrome.storage.local` |
| Session number | `localStorage` | `chrome.storage.local` |
| Session ID and last activity | `localStorage` | `chrome.storage.session` |
| User properties | `localStorage` | `chrome.storage.local` |

### Service-worker teardown

Chrome stops an MV3 service worker once it goes idle, and a `chrome.storage` write still pending at that moment is lost. If the lost write was a new client ID, the next start creates another one and the user is counted twice.

**Create the client ID at install time.** Register this at the top level of the service worker, outside Angular:

```typescript
import { seedNgGa4ClientId } from '@stream-vessel/ng-ga4';

chrome.runtime.onInstalled.addListener(() => seedNgGa4ClientId());
```

Run it on every `onInstalled`, not only `reason === 'install'`: users of an already published extension only ever get `'update'`. The call is idempotent and never throws. It doesn't help a user who clears extension storage, since `onInstalled` doesn't fire again.

**Wait for pending writes before an event handler returns**, after tracking calls and after `setConsent()`:

```typescript
chrome.action.onClicked.addListener(async () => {
    ga.trackEvent('action_clicked');
    await ga.flushStorage();
});
```

`flushStorage()` covers storage, not event delivery ([#26](https://github.com/streamvessel/ng-ga4/issues/26)). Neither step survives a browser crash or an extension reload.

### Sessions across tabs

Every hit first reads the stored session and adopts a newer one, so tabs agree on the current session. On the web that read comes from `localStorage`. Extensions can't read `chrome.storage` synchronously, so they follow it through `chrome.storage.onChanged`.

## Debug mode

`debug: true` tags every event with `debug_mode`, so it shows in [DebugView](https://support.google.com/analytics/answer/7201382). **Events are still recorded** and go out over your configured transport. Each payload is also posted to the [validation endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events), and any problems it reports are logged with `console.warn`.

```typescript
provideNgGa4({ ...config, debug: !environment.production })
```

## Other notes

- **Server-side rendering:** on the server the library does nothing: no storage and no hits. Calls made there are dropped, not replayed, since the browser sends its own page view once the app starts.
- **Device detection:** the Measurement Protocol ignores the `User-Agent` header, so the library sends a `device` object built from User-Agent Client Hints where available (Chromium), filled in from a built-in user-agent parser elsewhere.
- **API secret:** anyone can read it from the built bundle; that is inherent to the Measurement Protocol in a browser. It lets someone send fake events, not read your data. If you see abuse, delete the secret in GA4, create a new one and redeploy.

## Peer dependencies

- `@angular/core`, `@angular/common`, `@angular/router`: `^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0 || ^20.0.0`
- `rxjs`: `^7.0.0`

CI tests Angular 18 only. Reports of breakage on other majors are welcome.

## Local development

```bash
pnpm install
pnpm run build    # builds into dist/ng-ga4
pnpm test         # Karma/Jasmine, headless Chrome
pnpm run lint
```

To try an unreleased build in another app, run `pnpm run build` here and `pnpm add file:../ng-ga4/dist/ng-ga4` there. Switch back to the registry version before committing that app.

## License

Apache-2.0. See [LICENSE](https://github.com/streamvessel/ng-ga4/blob/master/LICENSE).

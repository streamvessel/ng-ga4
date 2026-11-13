# @stream-vessel/ng-ga4

[![npm](https://img.shields.io/npm/v/@stream-vessel/ng-ga4)](https://www.npmjs.com/package/@stream-vessel/ng-ga4)
[![CI](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml/badge.svg)](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/streamvessel/ng-ga4/blob/master/LICENSE)

Google Analytics 4 for Angular over the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4). It loads no remote script, so it works under a strict CSP and in Chrome extensions (Manifest V3), following Google's [Chrome Extensions GA4 guide](https://developer.chrome.com/docs/extensions/how-to/integrate/google-analytics-4).

Used in production in the [Stream Vessel](https://streamvessel.com) Chrome extension.

## Features

- No `gtag.js` and no external scripts
- Automatic page views from the Angular Router
- Opt-in Enhanced Measurement events: scrolls, outbound clicks, file downloads, site search, forms and video
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
- **City and region:** no data. The country still shows, guessed from the browser's time zone,
  and so do the continent and subcontinent that follow from it.

These work as usual: events, page views, active users and average engagement time.

We checked all of this on a real GA4 property; [Limitations](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/limitations.md) has the details.

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
- `enabled` (`boolean`): whether collection starts on. `false` creates no client ID and writes nothing until `setEnabled(true)`. See [Consent](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/consent.md).
- `isExtension` (`boolean`): `true` in a Chrome extension, so state goes to `chrome.storage` instead of `localStorage`.

**Optional** options are described in [Configuration](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/configuration.md#optional).

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
| `trackEvent(name, params?)` | Send a custom event. Checked against GA4's naming rules first; see [Event validation](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/event-validation.md). |
| `trackPageView(path, title?)` | Send a page view. Called for you on navigation. |
| `setUserId(userId)` | Send `user_id` on every hit from now on; `null` on sign-out. See [User ID](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/identity.md#user-id). |
| `setUserProperties(properties)` | Set user properties, sent with every later hit. See [User properties](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/identity.md#user-properties). |
| `setConsent(consent)` | Update consent. Keys you leave out stay as they are. See [Consent](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/consent.md). |
| `setEnabled(enabled)` | Turn collection on or off. The first `true` runs the initialisation that `enabled: false` skipped. See [Consent](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/consent.md). |
| `flushStorage()` | Resolves once pending `chrome.storage` writes have landed. Resolves at once on the web. See [Service-worker teardown](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/chrome-extensions.md#service-worker-teardown). |
| `init()` | Starts the library. Runs for you at app start. |

Calls made while collection is off are dropped. Calls made after `init()` has started but before it finishes are queued and sent once it does; calls made before it starts (for example from an earlier `APP_INITIALIZER`) are dropped.

Also exported: `seedNgGa4ClientId()` (see [Chrome extensions](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/chrome-extensions.md)), `NgGa4Config`, `NgGa4CookieOptions`, `NgGa4Consent`, `NgGa4ConsentState`, `NgGa4UserPropertyValue`, `NgGa4EnhancedMeasurement` and `NG_GA4_CONFIG`.

## Documentation

- [Configuration](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/configuration.md): every option
- [Identity](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/identity.md): client ID and `gtag.js`, user ID, user properties
- [Consent](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/consent.md)
- [Chrome extensions](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/chrome-extensions.md): setup, service-worker teardown, sessions across tabs
- [Engagement time and debug mode](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/engagement.md)
- [Enhanced measurement](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/enhanced-measurement.md): opt-in scroll, outbound click, file download, site search, form and video events
- [Event validation](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/event-validation.md): the event and parameter name rules `trackEvent()` checks
- [Limitations](https://github.com/streamvessel/ng-ga4/blob/master/projects/ng-ga4/docs/limitations.md): what the Measurement Protocol can't do, with measurements

The topic docs are documented for the latest `master`, which can be ahead of the release on npm. Unreleased changes are listed under [Unreleased](https://github.com/streamvessel/ng-ga4/blob/master/CHANGELOG.md#unreleased) in the changelog.

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

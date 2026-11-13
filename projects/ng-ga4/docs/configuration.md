# Configuration

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

## Required

- `measurementId` (`string`): GA4 Measurement ID, e.g. `G-XXXXXXXXX`.
- `apiSecret` (`string`): Measurement Protocol API secret.
- `enabled` (`boolean`): whether collection starts on. `false` creates no client ID and writes nothing until `setEnabled(true)`. See [Consent](consent.md).
- `isExtension` (`boolean`): `true` in a Chrome extension, so state goes to `chrome.storage` instead of `localStorage`.

## Optional

- `siteUrl` (`string`): base of `page_location`, e.g. `https://example.com`. Needed in extensions, where the page address is `chrome-extension://…`. Without it, `page_location` is the page's full address.
- `appVersion` (`string`): sent as `app_version` on every event.
- `transport` (`'beacon' | 'xhr'`, default `'beacon'`): `'beacon'` tries `sendBeacon`, then `fetch` with `keepalive`, then XHR, so hits survive the page closing. `'xhr'` sends through `HttpClient` and your interceptors, but a request still in flight when the page closes is lost.
- `debug` (`boolean`, default `false`): see [Debug mode](engagement.md#debug-mode).
- `clientIdSource` (`'auto' | 'cookie' | 'storage'`, default `'auto'`): where the web client ID comes from. See [Client ID and gtag.js](identity.md#client-id-and-gtagjs). An unknown value logs a warning and falls back to `'auto'`, which reads `_ga`. Ignored in extensions.
- `writeGaCookie` (`boolean` or `NgGa4CookieOptions`, default `false`): write a `_ga` cookie when there is no valid one (web only). See [Client ID and gtag.js](identity.md#client-id-and-gtagjs).
- `sendEngagementOnHide` (`boolean`, default `true`): send the engagement time left over when the page is hidden or closed. See [Engagement time](engagement.md#engagement-time).
- `engagementEventName` (`string`, default `'page_engagement'`): name of that event. An invalid or reserved name (such as `user_engagement`) logs a warning and falls back to the default.
- `consent` (`NgGa4Consent`, default: storage granted): initial consent state. See [Consent](consent.md).

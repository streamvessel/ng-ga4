# Engagement time and debug mode

> Documented for the latest `master`, which can be ahead of the release on npm. Unreleased changes are listed under [Unreleased](../../../CHANGELOG.md#unreleased) in the changelog.

## Engagement time

Every hit carries `engagement_time_msec`: the time since the previous hit during which the page was visible **and** focused, the same interval `gtag.js` measures.

- Switching tabs, windows or apps, or minimising the browser, stops the clock. Coming back starts it again.
- Focus inside a child frame (an `iframe`, an embedded viewer) doesn't count.
- If your app itself runs inside another page's iframe, it only counts while that iframe has focus, so a reader who never clicks into it reports no engagement.
- Losing focus sends nothing; the time rides on the next hit.
- When the page is hidden or closed, the time left over goes out as one `page_engagement` event (see [`sendEngagementOnHide`](configuration.md#optional)), always over the unload-safe transport. That event waits until at least 1 second has built up; anything shorter rides on the next hit. Its `page_location` is the last path you reported in a page view; with `siteUrl` set and no page view yet, it has none, so the raw page address (and anything in its query) never goes out. Without this event, a visit with a single page view would report almost no engagement.

This feeds GA4's **average engagement time**. It does **not** make sessions count as engaged, so engaged sessions, engagement rate and bounce rate stay unusable ([#43](https://github.com/streamvessel/ng-ga4/issues/43)). Expect the numbers to come out close to `gtag.js`'s, possibly a little lower, since this library also stops the clock when the window loses focus.

## Debug mode

`debug: true` tags every event with `debug_mode`, so it shows in [DebugView](https://support.google.com/analytics/answer/7201382). **Events are still recorded** and go out over your configured transport. Each payload is also posted to the [validation endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events), and any problems it reports are logged with `console.warn`.

```typescript
provideNgGa4({ ...config, debug: !environment.production })
```

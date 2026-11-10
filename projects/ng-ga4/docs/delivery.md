# Delivery: batching and flush()

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

## Batching

With the default `'beacon'` transport, events are held for `batchDelayMs` (300 ms by default) and sent together, up to 25 per request, the Measurement Protocol's limit. A route change that also fires three custom events is one request, not four. Each event keeps the time it was tracked (`timestamp_micros`), so the wait doesn't change what GA4 records.

A batch goes out early when it reaches 25 events, when the page is hidden or closed, and when the service is destroyed. Events are only combined when everything outside the events themselves (client ID, user ID, user properties, consent, device) matches, so a `setConsent()` or `setUserId()` between two calls starts a new request. A batch also stays under the 64 KiB that `sendBeacon` accepts.

In an MV3 service worker there's no page to hide, so a batch relies on its timer, and a worker stopped inside that window loses it. `await flush()` before a handler returns (see [Service-worker teardown](chrome-extensions.md#service-worker-teardown)).

`transport: 'xhr'` doesn't batch: every call is its own request, sent at once.

## flush()

`flush()` sends whatever is queued at once, before its first `await`, so calling it without waiting still works in an unload handler. It then waits for calls made while `init()` was still running, and resolves once every request in flight and every pending `chrome.storage` write has settled. It never rejects, and resolves at once on the server.

## Track results

`trackEvent()` and `trackPageView()` return an `NgGa4TrackResult`. Ignoring it is fine; it is there for debugging and for your own tests:

```typescript
const { status, delivered } = this.analytics.trackEvent('purchase', { value: 9.99 });
console.log(status, await delivered);
```

| `status` | Meaning |
|---|---|
| `'accepted'` | Queued for the next batch, or sent |
| `'deferred'` | `init()` is still running; held and replayed, with its original time, once it finishes |
| `'invalid'` | The event name breaks GA4's rules (see [Event validation](event-validation.md)); not sent |
| `'disabled'` | Collection is off; dropped |
| `'uninitialized'` | `init()` hasn't started; dropped |
| `'server'` | Running on the server; dropped |

`delivered` resolves, and never rejects, to `'sent'` (the transport accepted the request), `'failed'` (a network error, or a non-2xx from something between you and GA4) or `'dropped'` (never sent). GA4 answers 2xx even to payloads it discards, so `'sent'` is as much as any transport can confirm; use [debug mode](engagement.md#debug-mode) to see what GA4 makes of a payload.

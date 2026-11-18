# Delivery: batching, flush() and the offline outbox

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

## Batching

Events are held for `batchDelayMs` (300 ms by default) and sent together, up to 25 per request, the Measurement Protocol's limit. A route change that also fires three custom events is one request, not four. Each event keeps the time it was tracked (`timestamp_micros`), so the wait doesn't change what GA4 records.

A batch goes out early when it reaches 25 events, when the page is hidden or closed, and when the service is destroyed. Events are only combined when everything outside the events themselves (client ID, user ID, user properties, consent, device) matches, so a `setConsent()` or `setUserId()` between two calls starts a new request. A batch also stays under the 64 KiB that `sendBeacon` accepts.

In an MV3 service worker there's no page to hide, so a batch relies on its timer, and a worker stopped inside that window loses it. `await flush()` before a handler returns (see [Service-worker teardown](chrome-extensions.md#service-worker-teardown)).

Both transports batch, as `gtag.js` does. Under `transport: 'xhr'` a batch goes out through `HttpClient` and your interceptors, except a batch sent as the page is hidden or closed, which takes the unload-safe `sendBeacon` chain since an XHR would be aborted.

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

`delivered` resolves, and never rejects, to `'sent'` (the transport accepted the request), `'stored'` (GA4 was unreachable; saved to the [offline outbox](#offline-outbox) for retry), `'failed'` (a network error, or a non-2xx from something between you and GA4) or `'dropped'` (never sent: the call wasn't accepted, the event was older than 72 hours, an HTTP interceptor swallowed it under `transport: 'xhr'`, or the service was destroyed before `init()` finished). GA4 answers 2xx even to payloads it discards, so `'sent'` is as much as any transport can confirm; use [debug mode](engagement.md#debug-mode) to see what GA4 makes of a payload.

## Offline outbox

A request that can't reach GA4 at all (the browser reports itself offline, or a DNS failure or connection reset) is saved and sent again on the next `init()`, when the browser comes back `online`, and after the next request that does get through. Its `delivered` resolves to `'stored'`. A replay is the original request: same client ID, user ID, user properties, consent and event times. Stored requests are merged back into full batches when replayed, so a long outage doesn't turn into hundreds of requests.

- It lives in `chrome.storage.local` in an extension and `localStorage` on the web, under `ga_outbox`.
- It holds at most 500 events, dropping the oldest first. Events older than 72 hours are dropped, since GA4 would record them at the wrong time.
- Only network failures are retried. GA4 answers 2xx to anything it receives, so an error status comes from something in between (a proxy, a blocker) and is not retried.
- With `analyticsStorage` denied nothing is saved, and withdrawing it deletes the outbox along with the client ID.
- In an extension, a popup and the service worker each replay on their own `init()`. If both start while the outbox holds requests, those requests can be sent twice.

# Delivery: batching

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

## Batching

With the default `'beacon'` transport, events are held for `batchDelayMs` (300 ms by default) and sent together, up to 25 per request, the Measurement Protocol's limit. A route change that also fires three custom events is one request, not four. Each event keeps the time it was tracked (`timestamp_micros`), so the wait doesn't change what GA4 records.

A batch goes out early when it reaches 25 events, when the page is hidden or closed, and when the service is destroyed. Events are only combined when everything outside the events themselves (client ID, user ID, user properties, consent, device) matches, so a `setConsent()` or `setUserId()` between two calls starts a new request. A batch also stays under the 64 KiB that `sendBeacon` accepts.

In an MV3 service worker there's no page to hide, so a batch relies on its timer, and a worker stopped inside that window loses it. Keep `batchDelayMs` short there.

`transport: 'xhr'` doesn't batch: every call is its own request, sent at once.

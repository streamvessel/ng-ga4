/**
 * What a `trackEvent()` / `trackPageView()` call did with the event, decided
 * synchronously:
 *
 * - `'accepted'`: handed to the send path — queued for the next batch, or sent.
 * - `'deferred'`: `init()` is still running; the call is held and replayed,
 *   with its original time, once it finishes.
 * - `'disabled'`: collection is off (`enabled: false` / `setEnabled(false)`). Dropped.
 * - `'uninitialized'`: `init()` has not started. Dropped, not held — see the README.
 * - `'server'`: running on the server (SSR / prerender). Dropped.
 */
export type NgGa4TrackStatus = 'accepted' | 'deferred' | 'disabled' | 'uninitialized' | 'server';

/**
 * How the request carrying the event settled:
 *
 * - `'sent'`: the transport took it. For `sendBeacon` that is the browser
 *   accepting it for delivery, not a response from GA4 — and GA4 answers 2xx
 *   even to a payload it discards, so no transport can promise more.
 * - `'stored'`: no transport could reach GA4 — offline, typically — so the
 *   request was saved and will be retried on the next `init()` or when the
 *   browser comes back online. See the README's "Offline outbox".
 * - `'failed'`: not sent and not stored: a non-2xx response (a proxy or
 *   blocker, since GA4 itself answers 2xx), or no network with
 *   `analyticsStorage` denied or storage unavailable.
 * - `'dropped'`: never sent — the call was not accepted (see the status), or
 *   the event was older than the Measurement Protocol's 72-hour window.
 */
export type NgGa4Delivery = 'sent' | 'stored' | 'failed' | 'dropped';

/**
 * Returned by the track methods. Ignoring it is fine: existing
 * `this.analytics.trackEvent(...)` call sites keep working, and nothing here
 * ever rejects, so an un-awaited `delivered` cannot surface as an unhandled
 * rejection.
 */
export interface NgGa4TrackResult {
    readonly status: NgGa4TrackStatus;
    /** Resolves once the event's request settles. Never rejects. */
    readonly delivered: Promise<NgGa4Delivery>;
}

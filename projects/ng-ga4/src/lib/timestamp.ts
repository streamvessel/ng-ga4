/**
 * How far back the Measurement Protocol lets `timestamp_micros` reach. Under the
 * default `validation_behavior` an older event is not rejected but re-stamped to
 * exactly 72 hours ago — a time it did not happen at — so it is dropped instead.
 */
export const MP_MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * `Date.now()` in the microseconds the Measurement Protocol expects.
 *
 * Wall-clock, not `performance.now()`: this is a point in time GA4 reports
 * against, not a duration. Stays a safe integer until the year 2255.
 */
export function toTimestampMicros(epochMs: number): number {
    return Math.round(epochMs) * 1000;
}

/**
 * True while an event stamped `timestampMicros` can still be sent at `nowMs`.
 * A timestamp in the future counts as within the window; see clampToNow.
 */
export function isWithinBackdateWindow(timestampMicros: number, nowMs: number): boolean {
    return nowMs - timestampMicros / 1000 <= MP_MAX_EVENT_AGE_MS;
}

/**
 * A future timestamp (the wall clock corrected backwards between capture and
 * send) has no documented meaning on the Measurement Protocol, and
 * `ENFORCE_RECOMMENDATIONS` would reject it as "not within the last 72 hours".
 * Clamped to the send time rather than dropped: the event did happen.
 */
export function clampToNow(timestampMicros: number, nowMs: number): number {
    return Math.min(timestampMicros, toTimestampMicros(nowMs));
}

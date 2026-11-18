/** The Measurement Protocol's hard limit on events in one request. */
export const MP_MAX_EVENTS_PER_REQUEST = 25;

/**
 * The byte budget for one batched request body.
 *
 * The Measurement Protocol takes up to 130 kB, but `sendBeacon` and
 * `fetch(keepalive)` share a 64 KiB in-flight quota per page, and a body over
 * it is refused outright. Staying under it keeps a batch on the unload-safe
 * transports; the headroom covers the request-level fields counted only once.
 */
export const MAX_BATCH_BYTES = 60 * 1024;

/**
 * The shape the batcher needs from a request body. Everything other than
 * `events` is the request's *envelope* — `client_id`, `user_id`, `device`,
 * `user_location`, `consent`, `user_properties`, and whatever request-level
 * field is added later — and two bodies are merged only when their envelopes
 * match exactly. That keeps an event under the consent and identity it was
 * tracked with, even if either changed before the flush.
 *
 * Bodies carry no request-level `timestamp_micros`: each event has its own,
 * and the service derives the request's when it sends.
 */
export interface BatchableBody {
    events: unknown[];
}

/**
 * Coalesces single-event request bodies into as few requests as the
 * Measurement Protocol allows, preserving order.
 *
 * Pure bookkeeping: no timers, no transport, no storage. The service decides
 * when to `drain()`; what it drains is always a complete, sendable request
 * body, which is also what the outbox (#25) persists and replays.
 */
export class EventBatcher<B extends BatchableBody, T> {
    private batches: Array<{ body: B; key: string; bytes: number; tickets: T[] }> = [];

    constructor(
        private readonly maxEvents = MP_MAX_EVENTS_PER_REQUEST,
        private readonly maxBytes = MAX_BATCH_BYTES
    ) {}

    /**
     * Queue a body. Returns `true` when a batch is now full, which is the
     * caller's signal to flush without waiting for its timer.
     *
     * `ticket` is opaque caller data that travels with the body into whichever
     * batch it lands in — the service uses it to settle each call's
     * `delivered` promise once its batch's request does.
     */
    add(body: B, ticket: T): boolean {
        const key = envelopeKey(body);
        const eventBytes = jsonBytes(body.events);
        // Only the newest batch is a merge candidate: merging into an older one
        // would send a later event ahead of an earlier one with a different envelope.
        const last = this.batches[this.batches.length - 1];
        if (
            last
            && last.key === key
            && last.body.events.length + body.events.length <= this.maxEvents
            // Envelope bytes are counted once; only the events are added.
            && last.bytes + eventBytes <= this.maxBytes
        ) {
            // In place: the batch owns its events array (copied below).
            last.body.events.push(...body.events);
            // An upper bound, not exact: the merged array saves the incoming
            // array's brackets. Re-stringifying the batch per add would be
            // quadratic over a burst.
            last.bytes += eventBytes;
            last.tickets.push(ticket);
        } else {
            this.batches.push({ body: { ...body, events: [...body.events] }, key, bytes: jsonBytes(body), tickets: [ticket] });
        }
        const newest = this.batches[this.batches.length - 1];
        return newest.body.events.length >= this.maxEvents;
    }

    /** True when nothing is queued. */
    get isEmpty(): boolean {
        return this.batches.length === 0;
    }

    /**
     * Remove and return every queued batch, oldest first, each with the
     * tickets of the calls merged into it.
     */
    drain(): Array<{ body: B; tickets: T[] }> {
        const drained = this.batches.map(({ body, tickets }) => ({ body, tickets }));
        this.batches = [];
        return drained;
    }
}

function envelopeKey(body: BatchableBody): string {
    return stableStringify({ ...body, events: undefined });
}

// Key order is not part of a body's meaning, so two envelopes built along
// different code paths must still compare equal.
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.keys(value as object)
            .filter(k => (value as Record<string, unknown>)[k] !== undefined)
            .sort()
            .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

// UTF-16 length is a lower bound on UTF-8 bytes; for an over-the-limit check a
// conservative upper bound is wanted, so non-ASCII is counted at 3 bytes.
function jsonBytes(value: unknown): number {
    const json = JSON.stringify(value) ?? '';
    let bytes = 0;
    for (let i = 0; i < json.length; i++) {
        bytes += json.charCodeAt(i) < 0x80 ? 1 : 3;
    }
    return bytes;
}

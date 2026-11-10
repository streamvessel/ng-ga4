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
 * `events` and `timestamp_micros` is the request's *envelope* — `client_id`,
 * `device`, `user_location`, `consent`, and whatever request-level field is
 * added later — and two bodies are merged only when their envelopes match
 * exactly. That keeps an event under the consent and identity it was tracked
 * with, even if either changed before the flush.
 */
export interface BatchableBody {
    events: Array<{ timestamp_micros?: number }>;
    timestamp_micros?: number;
}

/**
 * Coalesces single-event request bodies into as few requests as the
 * Measurement Protocol allows, preserving order.
 *
 * Pure bookkeeping: no timers, no transport, no storage. The service decides
 * when to `take()`; the outbox (#25) persists and replays what it takes, so
 * a batch is always a complete, sendable request body.
 */
export class EventBatcher<B extends BatchableBody, T = never> {
    private batches: Array<{ body: B; key: string; bytes: number; tickets: T[] }> = [];

    constructor(
        private readonly maxEvents = MP_MAX_EVENTS_PER_REQUEST,
        private readonly maxBytes = MAX_BATCH_BYTES
    ) {}

    /** Number of events waiting, across all batches. */
    get size(): number {
        return this.batches.reduce((n, batch) => n + batch.body.events.length, 0);
    }

    /**
     * Queue a body. Returns `true` when a batch is now full, which is the
     * caller's signal to flush without waiting for its timer.
     *
     * `ticket` is opaque caller data that travels with the body into whichever
     * batch it lands in — the service uses it to settle each call's
     * `delivered` promise once its batch's request does.
     */
    add(body: B, ticket?: T): boolean {
        const tickets = ticket === undefined ? [] : [ticket];
        const key = envelopeKey(body);
        const bytes = jsonBytes(body);
        // Only the newest batch is a merge candidate: merging into an older one
        // would send a later event ahead of an earlier one with a different envelope.
        const last = this.batches[this.batches.length - 1];
        if (
            last
            && last.key === key
            && last.body.events.length + body.events.length <= this.maxEvents
            // Envelope bytes are counted once; only the events are added.
            && last.bytes + jsonBytes(body.events) <= this.maxBytes
        ) {
            last.body = merge(last.body, body);
            last.bytes = jsonBytes(last.body);
            last.tickets.push(...tickets);
        } else {
            this.batches.push({ body: { ...body, events: [...body.events] }, key, bytes, tickets });
        }
        const newest = this.batches[this.batches.length - 1];
        return newest.body.events.length >= this.maxEvents;
    }

    /** Remove and return every queued batch, oldest first. */
    take(): B[] {
        return this.drain().map(batch => batch.body);
    }

    /** As `take()`, with the tickets of the calls merged into each batch. */
    drain(): Array<{ body: B; tickets: T[] }> {
        const drained = this.batches.map(({ body, tickets }) => ({ body, tickets }));
        this.batches = [];
        return drained;
    }
}

function merge<B extends BatchableBody>(into: B, from: B): B {
    const events = [...into.events, ...from.events];
    const merged: B = { ...into, events };
    // The request-level time is the earliest in the batch; each event keeps its own.
    const times = [into.timestamp_micros, from.timestamp_micros].filter((t): t is number => typeof t === 'number');
    if (times.length) {
        merged.timestamp_micros = Math.min(...times);
    }
    return merged;
}

function envelopeKey(body: BatchableBody): string {
    return stableStringify({ ...body, events: undefined, timestamp_micros: undefined });
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

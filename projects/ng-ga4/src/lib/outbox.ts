import { isWithinBackdateWindow } from './timestamp';

/** Storage key, in `chrome.storage.local` or `localStorage`. */
export const OUTBOX_STORAGE_KEY = 'ga_outbox';

/**
 * At most this many events are kept. Past it the oldest are evicted first:
 * they are the closest to falling out of the 72-hour window anyway, and the
 * newest are the ones still worth most.
 *
 * Sized for a few hours offline at an ordinary event rate, and small enough
 * (well under 1 MB) that `localStorage`'s ~5 MB per origin is never the limit.
 */
export const OUTBOX_MAX_EVENTS = 500;

/** The fields of a request body the outbox looks at; the rest rides along. */
export interface OutboxBody {
    client_id: string;
    timestamp_micros?: number;
    events: Array<{ name: string; timestamp_micros?: number }>;
}

/**
 * Validates what came back from storage. Another version of this library, a
 * user editing storage by hand, or a truncated write can all leave something
 * else there, and replaying junk would at best waste a request.
 */
export function parseOutbox<B extends OutboxBody>(raw: unknown): B[] {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((body): body is B =>
        !!body
        && typeof body === 'object'
        && typeof body.client_id === 'string'
        && Array.isArray(body.events)
        && body.events.every((event: unknown) =>
            !!event && typeof (event as { name?: unknown }).name === 'string'
            && typeof (event as { timestamp_micros?: unknown }).timestamp_micros === 'number'));
}

/**
 * Drops events past the Measurement Protocol's 72-hour window, drops bodies
 * left empty, re-derives each request-level `timestamp_micros` from what
 * remains, then evicts oldest-first down to `maxEvents`. Order is kept.
 */
export function pruneOutbox<B extends OutboxBody>(bodies: B[], nowMs: number, maxEvents = OUTBOX_MAX_EVENTS): B[] {
    const fresh = bodies
        .map(body => withEvents(body, body.events.filter(e =>
            typeof e.timestamp_micros === 'number' && isWithinBackdateWindow(e.timestamp_micros, nowMs))))
        .filter(body => body.events.length > 0);

    let excess = fresh.reduce((n, body) => n + body.events.length, 0) - maxEvents;
    const kept: B[] = [];
    for (const body of fresh) {
        if (excess <= 0) {
            kept.push(body);
        } else if (body.events.length <= excess) {
            excess -= body.events.length;
        } else {
            kept.push(withEvents(body, body.events.slice(excess)));
            excess = 0;
        }
    }
    return kept;
}

function withEvents<B extends OutboxBody>(body: B, events: B['events']): B {
    if (events.length === body.events.length) {
        return body;
    }
    const times = events.map(e => e.timestamp_micros).filter((t): t is number => typeof t === 'number');
    return {
        ...body,
        events,
        ...(times.length ? { timestamp_micros: Math.min(...times) } : {})
    };
}

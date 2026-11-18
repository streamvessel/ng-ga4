import { isWithinBackdateWindow } from './timestamp';

/** Storage key, in `chrome.storage.local` or `localStorage`. */
export const OUTBOX_STORAGE_KEY = 'ga_outbox';

/**
 * At most this many events are kept. Past it the oldest are evicted first:
 * they are the closest to falling out of the 72-hour window anyway, and the
 * newest are the ones still worth most. Sized for a few hours offline at an
 * ordinary event rate.
 */
export const OUTBOX_MAX_EVENTS = 500;

/**
 * And at most this many characters of stored JSON, whichever limit is hit
 * first. A batch may be up to 60 KiB for 25 events and each stored request
 * repeats its envelope, so 500 large events could otherwise pass 1 MB — a
 * fifth of `localStorage`'s ~5 MB per origin, shared with the app's own data.
 */
export const OUTBOX_MAX_CHARS = 1_000_000;

/** The fields of a request body the outbox looks at; the rest rides along. */
export interface OutboxBody {
    client_id: string;
    events: Array<{ name: string; timestamp_micros: number }>;
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
 * left empty, then evicts oldest-first down to `maxEvents` and to `maxChars`
 * of JSON. Order is kept.
 */
export function pruneOutbox<B extends OutboxBody>(
    bodies: B[],
    nowMs: number,
    maxEvents = OUTBOX_MAX_EVENTS,
    maxChars = OUTBOX_MAX_CHARS
): B[] {
    const fresh = bodies
        .map(body => withEvents(body, body.events.filter(e => isWithinBackdateWindow(e.timestamp_micros, nowMs))))
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

    // Whole requests, oldest first: a request's envelope is most of its size
    // when it holds few events, so splitting one would free little.
    const sizes = kept.map(body => JSON.stringify(body).length);
    let chars = sizes.reduce((n, size) => n + size + 1, 1);
    let first = 0;
    while (chars > maxChars && first < kept.length - 1) {
        chars -= sizes[first++] + 1;
    }
    return first ? kept.slice(first) : kept;
}

function withEvents<B extends OutboxBody>(body: B, events: B['events']): B {
    return events.length === body.events.length ? body : { ...body, events };
}

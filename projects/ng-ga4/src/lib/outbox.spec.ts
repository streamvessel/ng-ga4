import { OUTBOX_MAX_EVENTS, parseOutbox, pruneOutbox, OutboxBody } from './outbox';

const NOW = 1700000000000;
const HOUR = 60 * 60 * 1000;

function body(names: string[], ageMs: number[], clientId = 'c1'): OutboxBody {
    const events = names.map((name, i) => ({ name, timestamp_micros: (NOW - ageMs[i]) * 1000 }));
    return { client_id: clientId, timestamp_micros: Math.min(...events.map(e => e.timestamp_micros)), events };
}

describe('outbox', () => {
    describe('parseOutbox', () => {
        it('accepts an array of request bodies, or its JSON', () => {
            const stored = [body(['a'], [0])];
            expect(parseOutbox(stored)).toEqual(stored);
            expect(parseOutbox(JSON.stringify(stored))).toEqual(stored);
        });

        it('returns nothing for missing, malformed or foreign values', () => {
            for (const raw of [undefined, null, '', '{', '{}', 42, { events: [] }]) {
                expect(parseOutbox(raw)).toEqual([]);
            }
        });

        it('skips entries that are not complete request bodies', () => {
            const good = body(['a'], [0]);
            const raw = [good, null, { client_id: 1, events: [] }, { client_id: 'c', events: [{ name: 'x' }] }, { client_id: 'c' }];
            expect(parseOutbox(raw)).toEqual([good]);
        });
    });

    describe('pruneOutbox', () => {
        it('keeps events inside 72 hours and drops older ones', () => {
            const pruned = pruneOutbox([body(['old', 'fresh'], [73 * HOUR, HOUR])], NOW);

            expect(pruned[0].events.map(e => e.name)).toEqual(['fresh']);
            // Re-derived from what is left, not the dropped event's time.
            expect(pruned[0].timestamp_micros).toBe((NOW - HOUR) * 1000);
        });

        it('drops a body left with no events', () => {
            expect(pruneOutbox([body(['old'], [80 * HOUR]), body(['new'], [0])], NOW).map(b => b.events[0].name))
                .toEqual(['new']);
        });

        it('evicts oldest-first past the cap, splitting a body if needed', () => {
            const pruned = pruneOutbox([body(['a', 'b'], [3, 2]), body(['c', 'd'], [1, 0])], NOW, 3);

            expect(pruned.map(b => b.events.map(e => e.name))).toEqual([['b'], ['c', 'd']]);
        });

        it('defaults the cap to OUTBOX_MAX_EVENTS', () => {
            const many = Array.from({ length: OUTBOX_MAX_EVENTS + 10 }, (_, i) => body([`e${i}`], [0]));

            const pruned = pruneOutbox(many, NOW);

            expect(pruned.length).toBe(OUTBOX_MAX_EVENTS);
            expect(pruned[0].events[0].name).toBe('e10');
        });

        it('returns an untouched body as the same object', () => {
            const kept = body(['a'], [0]);
            expect(pruneOutbox([kept], NOW)[0]).toBe(kept);
        });
    });
});

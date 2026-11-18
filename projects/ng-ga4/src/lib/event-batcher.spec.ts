import { EventBatcher, MP_MAX_EVENTS_PER_REQUEST } from './event-batcher';

interface Body {
    client_id: string;
    events: Array<{ name: string; timestamp_micros?: number; params?: Record<string, unknown> }>;
    consent?: Record<string, string>;
}

function body(name: string, extra: Partial<Body> = {}, ts = 1000): Body {
    return { client_id: 'c1', events: [{ name, timestamp_micros: ts }], ...extra };
}

// The tickets are irrelevant to most specs.
function batcherOf(maxEvents?: number, maxBytes?: number): EventBatcher<Body, null> {
    return new EventBatcher<Body, null>(maxEvents, maxBytes);
}

const bodies = (batcher: EventBatcher<Body, unknown>) => batcher.drain().map(b => b.body);

describe('EventBatcher', () => {
    it('merges bodies with the same envelope into one, in order, each event keeping its time', () => {
        const batcher = batcherOf();
        batcher.add(body('a', {}, 3000), null);
        batcher.add(body('b', {}, 1000), null);
        batcher.add(body('c', {}, 2000), null);

        const [only, ...rest] = bodies(batcher);
        expect(rest).toEqual([]);
        expect(only.events.map(e => e.name)).toEqual(['a', 'b', 'c']);
        expect(only.events.map(e => e.timestamp_micros)).toEqual([3000, 1000, 2000]);
    });

    it('starts a new batch when the envelope differs', () => {
        const batcher = batcherOf();
        batcher.add(body('a'), null);
        batcher.add(body('b', { consent: { ad_user_data: 'DENIED' } }), null);
        batcher.add(body('c', { consent: { ad_user_data: 'DENIED' } }), null);

        const batches = bodies(batcher);
        expect(batches.map(b => b.events.map(e => e.name))).toEqual([['a'], ['b', 'c']]);
        expect(batches[0].consent).toBeUndefined();
        expect(batches[1].consent).toEqual({ ad_user_data: 'DENIED' });
    });

    // Merging into an older batch would reorder events across envelopes.
    it('only ever merges into the newest batch', () => {
        const batcher = batcherOf();
        batcher.add(body('a'), null);
        batcher.add(body('b', { client_id: 'c2' }), null);
        batcher.add(body('c'), null);

        expect(bodies(batcher).map(b => b.events.map(e => e.name))).toEqual([['a'], ['b'], ['c']]);
    });

    it('ignores key order and undefined fields when comparing envelopes', () => {
        const batcher = batcherOf();
        batcher.add({ consent: { a: '1', b: '2' }, client_id: 'c1', events: [{ name: 'x' }] }, null);
        batcher.add({ client_id: 'c1', consent: { b: '2', a: '1' }, events: [{ name: 'y' }], ...{ extra: undefined } } as Body, null);

        expect(bodies(batcher).length).toBe(1);
    });

    it('reports full at 25 events and puts the 26th in a new batch', () => {
        const batcher = batcherOf();
        const fullness: boolean[] = [];
        for (let i = 0; i < MP_MAX_EVENTS_PER_REQUEST + 1; i++) {
            fullness.push(batcher.add(body(`e${i}`), null));
        }

        expect(fullness.indexOf(true)).toBe(MP_MAX_EVENTS_PER_REQUEST - 1);
        expect(fullness[MP_MAX_EVENTS_PER_REQUEST]).toBeFalse();
        expect(bodies(batcher).map(b => b.events.length)).toEqual([25, 1]);
    });

    it('starts a new batch rather than exceed the byte budget', () => {
        const batcher = batcherOf(25, 400);
        const padding = 'x'.repeat(150);
        batcher.add({ client_id: 'c1', events: [{ name: 'a', params: { padding } }] }, null);
        batcher.add({ client_id: 'c1', events: [{ name: 'b', params: { padding } }] }, null);

        expect(bodies(batcher).map(b => b.events.length)).toEqual([1, 1]);
    });

    it('counts non-ASCII conservatively against the byte budget', () => {
        const ascii = batcherOf(25, 400);
        const wide = batcherOf(25, 400);
        for (const [batcher, text] of [[ascii, 'x'.repeat(60)], [wide, 'é'.repeat(60)]] as const) {
            batcher.add({ client_id: 'c1', events: [{ name: 'a', params: { text } }] }, null);
            batcher.add({ client_id: 'c1', events: [{ name: 'b', params: { text } }] }, null);
        }

        expect(bodies(ascii).length).toBe(1);
        expect(bodies(wide).length).toBe(2);
    });

    it('sends a single oversized body on its own rather than dropping it', () => {
        const batcher = batcherOf(25, 100);
        batcher.add({ client_id: 'c1', events: [{ name: 'big', params: { p: 'x'.repeat(500) } }] }, null);

        expect(bodies(batcher).length).toBe(1);
    });

    it('empties on drain()', () => {
        const batcher = batcherOf();
        batcher.add(body('a'), null);
        batcher.add(body('b', { client_id: 'c2' }), null);
        expect(batcher.isEmpty).toBeFalse();

        expect(batcher.drain().length).toBe(2);
        expect(batcher.isEmpty).toBeTrue();
        expect(batcher.drain()).toEqual([]);
    });

    it('does not mutate the bodies it was given', () => {
        const batcher = batcherOf();
        const first = body('a');
        batcher.add(first, null);
        batcher.add(body('b'), null);
        batcher.drain();

        expect(first.events.length).toBe(1);
    });

    it('carries each call\'s ticket into the batch it lands in', () => {
        const batcher = new EventBatcher<Body, string>();
        batcher.add(body('a'), 't1');
        batcher.add(body('b'), 't2');
        batcher.add(body('c', { client_id: 'c2' }), 't3');
        batcher.add(body('d', { client_id: 'c2' }), 't4');

        expect(batcher.drain().map(b => b.tickets)).toEqual([['t1', 't2'], ['t3', 't4']]);
    });
});

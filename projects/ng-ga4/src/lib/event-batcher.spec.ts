import { EventBatcher, MP_MAX_EVENTS_PER_REQUEST } from './event-batcher';

interface Body {
    client_id: string;
    timestamp_micros?: number;
    events: Array<{ name: string; timestamp_micros?: number; params?: Record<string, unknown> }>;
    consent?: Record<string, string>;
}

function body(name: string, extra: Partial<Body> = {}, ts = 1000): Body {
    return { client_id: 'c1', timestamp_micros: ts, events: [{ name, timestamp_micros: ts }], ...extra };
}

describe('EventBatcher', () => {
    it('merges bodies with the same envelope into one, in order', () => {
        const batcher = new EventBatcher<Body>();
        batcher.add(body('a', {}, 3000));
        batcher.add(body('b', {}, 1000));
        batcher.add(body('c', {}, 2000));

        const [only, ...rest] = batcher.take();
        expect(rest).toEqual([]);
        expect(only.events.map(e => e.name)).toEqual(['a', 'b', 'c']);
        expect(only.events.map(e => e.timestamp_micros)).toEqual([3000, 1000, 2000]);
        expect(only.timestamp_micros).toBe(1000);
    });

    it('starts a new batch when the envelope differs', () => {
        const batcher = new EventBatcher<Body>();
        batcher.add(body('a'));
        batcher.add(body('b', { consent: { ad_user_data: 'DENIED' } }));
        batcher.add(body('c', { consent: { ad_user_data: 'DENIED' } }));

        const batches = batcher.take();
        expect(batches.map(b => b.events.map(e => e.name))).toEqual([['a'], ['b', 'c']]);
        expect(batches[0].consent).toBeUndefined();
        expect(batches[1].consent).toEqual({ ad_user_data: 'DENIED' });
    });

    // Merging into an older batch would reorder events across envelopes.
    it('only ever merges into the newest batch', () => {
        const batcher = new EventBatcher<Body>();
        batcher.add(body('a'));
        batcher.add(body('b', { client_id: 'c2' }));
        batcher.add(body('c'));

        expect(batcher.take().map(b => b.events.map(e => e.name))).toEqual([['a'], ['b'], ['c']]);
    });

    it('ignores key order and undefined fields when comparing envelopes', () => {
        const batcher = new EventBatcher<Body>();
        batcher.add({ consent: { a: '1', b: '2' }, client_id: 'c1', events: [{ name: 'x' }] });
        batcher.add({ client_id: 'c1', consent: { b: '2', a: '1' }, events: [{ name: 'y' }], ...{ extra: undefined } } as Body);

        expect(batcher.take().length).toBe(1);
    });

    it('reports full at 25 events and puts the 26th in a new batch', () => {
        const batcher = new EventBatcher<Body>();
        const fullness: boolean[] = [];
        for (let i = 0; i < MP_MAX_EVENTS_PER_REQUEST + 1; i++) {
            fullness.push(batcher.add(body(`e${i}`)));
        }

        expect(fullness.indexOf(true)).toBe(MP_MAX_EVENTS_PER_REQUEST - 1);
        expect(fullness[MP_MAX_EVENTS_PER_REQUEST]).toBeFalse();
        expect(batcher.take().map(b => b.events.length)).toEqual([25, 1]);
    });

    it('starts a new batch rather than exceed the byte budget', () => {
        const batcher = new EventBatcher<Body>(25, 400);
        const padding = 'x'.repeat(150);
        batcher.add({ client_id: 'c1', events: [{ name: 'a', params: { padding } }] });
        batcher.add({ client_id: 'c1', events: [{ name: 'b', params: { padding } }] });

        expect(batcher.take().map(b => b.events.length)).toEqual([1, 1]);
    });

    it('counts non-ASCII conservatively against the byte budget', () => {
        const ascii = new EventBatcher<Body>(25, 400);
        const wide = new EventBatcher<Body>(25, 400);
        for (const [batcher, text] of [[ascii, 'x'.repeat(60)], [wide, 'é'.repeat(60)]] as const) {
            batcher.add({ client_id: 'c1', events: [{ name: 'a', params: { text } }] });
            batcher.add({ client_id: 'c1', events: [{ name: 'b', params: { text } }] });
        }

        expect(ascii.take().length).toBe(1);
        expect(wide.take().length).toBe(2);
    });

    it('sends a single oversized body on its own rather than dropping it', () => {
        const batcher = new EventBatcher<Body>(25, 100);
        batcher.add({ client_id: 'c1', events: [{ name: 'big', params: { p: 'x'.repeat(500) } }] });

        expect(batcher.take().length).toBe(1);
    });

    it('empties on take() and tracks size', () => {
        const batcher = new EventBatcher<Body>();
        batcher.add(body('a'));
        batcher.add(body('b', { client_id: 'c2' }));
        expect(batcher.size).toBe(2);

        batcher.take();
        expect(batcher.size).toBe(0);
        expect(batcher.take()).toEqual([]);
    });

    it('does not mutate the bodies it was given', () => {
        const batcher = new EventBatcher<Body>();
        const first = body('a');
        batcher.add(first);
        batcher.add(body('b'));
        batcher.take();

        expect(first.events.length).toBe(1);
    });
});

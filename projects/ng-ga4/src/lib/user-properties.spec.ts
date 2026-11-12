import {
    applyUserPropertyUpdate,
    emptyUserPropertyUpdate,
    foldUserPropertyUpdate,
    MAX_USER_PROPERTIES,
    NgGa4UserPropertyValue,
    parseStoredUserProperties,
    serializeUserProperties,
    toUserPropertiesPayload,
    userPropertyNameProblem,
    userPropertyValueProblem
} from './user-properties';

describe('user properties', () => {
    function fullMap(): Record<string, string> {
        const map: Record<string, string> = {};
        for (let i = 0; i < MAX_USER_PROPERTIES; i++) {
            map[`p${i}`] = 'v';
        }
        return map;
    }

    function update(...calls: Array<Record<string, NgGa4UserPropertyValue | undefined> | null>) {
        const u = emptyUserPropertyUpdate();
        const problems = calls.flatMap(call => foldUserPropertyUpdate(u, call));
        return { update: u, problems };
    }

    describe('userPropertyNameProblem()', () => {
        it('accepts letters, digits and underscores up to 24 characters', () => {
            expect(userPropertyNameProblem('Plan_Tier_2')).toBeNull();
            expect(userPropertyNameProblem('a'.repeat(24))).toBeNull();
        });

        it('rejects bad shapes', () => {
            for (const name of ['a'.repeat(25), '1plan', 'plan-tier', 'plan tier', '']) {
                expect(userPropertyNameProblem(name)).withContext(name).not.toBeNull();
            }
        });

        it('rejects the reserved names', () => {
            for (const name of ['first_open_time', 'first_visit_time', 'last_deep_link_referrer', 'user_id', 'first_open_after_install']) {
                expect(userPropertyNameProblem(name)).withContext(name).toContain('reserved');
            }
        });

        it('rejects the reserved prefixes in any letter case', () => {
            for (const name of ['_plan', 'firebase_plan', 'ga_plan', 'google_plan', 'GA_plan', 'Google_plan', 'Firebase_Plan']) {
                expect(userPropertyNameProblem(name)).withContext(name).toContain('reserved prefix');
            }
        });
    });

    describe('userPropertyValueProblem()', () => {
        it('accepts strings and finite numbers up to 36 code points', () => {
            for (const value of ['', 'x'.repeat(36), '😀'.repeat(36), 0, 42]) {
                expect(userPropertyValueProblem('p', value)).withContext(String(value)).toBeNull();
            }
        });

        it('rejects long values, non-finite numbers and other types', () => {
            for (const value of ['x'.repeat(37), '😀'.repeat(37), NaN, Infinity, true, { a: 1 }]) {
                expect(userPropertyValueProblem('p', value)).withContext(String(value)).not.toBeNull();
            }
        });
    });

    describe('foldUserPropertyUpdate()', () => {
        it('keeps valid values and nulls, drops invalid ones with a message each, and ignores undefined', () => {
            const { update: u, problems } = update({ plan: 'pro', seats: null, user_id: 'x', long: 'x'.repeat(37), later: undefined });

            expect([...u.values]).toEqual([['plan', 'pro'], ['seats', null]]);
            expect(problems.length).toBe(2);
        });

        it('lets an invalid later value leave a valid earlier one in place', () => {
            expect([...update({ plan: 'pro' }, { plan: 'x'.repeat(37) }).update.values]).toEqual([['plan', 'pro']]);
        });

        it('null clears everything folded so far', () => {
            const { update: u } = update({ plan: 'pro' }, null, { region: 'eu' });

            expect(u.clear).toBeTrue();
            expect([...u.values]).toEqual([['region', 'eu']]);
        });
    });

    describe('applyUserPropertyUpdate()', () => {
        it('sets, overwrites and removes without mutating its input', () => {
            const current = { plan: 'free', seats: 2 };
            const { properties } = applyUserPropertyUpdate(current, update({ plan: 'pro', seats: null, region: 'eu' }).update);

            expect(properties).toEqual({ plan: 'pro', region: 'eu' });
            expect(current).toEqual({ plan: 'free', seats: 2 });
        });

        it('starts from empty when the update clears', () => {
            expect(applyUserPropertyUpdate({ plan: 'pro' }, update(null, { region: 'eu' }).update).properties)
                .toEqual({ region: 'eu' });
        });

        it('caps at 25, keeping properties already held, including against Object.prototype names', () => {
            const { properties, problems } = applyUserPropertyUpdate(
                fullMap(),
                update({ p0: 'updated', extra: 'v', constructor: 'x' }).update
            );

            expect(Object.keys(properties).length).toBe(MAX_USER_PROPERTIES);
            expect(properties['p0']).toBe('updated');
            expect(Object.hasOwn(properties, 'extra')).toBeFalse();
            expect(problems.length).toBe(2);
        });

        it('makes room when a property is removed in the same update', () => {
            const { properties } = applyUserPropertyUpdate(fullMap(), update({ p0: null, extra: 'v' }).update);

            expect(properties['extra']).toBe('v');
        });
    });

    describe('parseStoredUserProperties()', () => {
        it('reads JSON and keeps only valid entries', () => {
            expect(parseStoredUserProperties('{"plan":"pro","user_id":"x","bad":{"a":1},"gone":null}')).toEqual({ plan: 'pro' });
        });

        it('returns an empty map for junk', () => {
            for (const raw of [null, undefined, 'not json', '[1,2]', '42', 42]) {
                expect(parseStoredUserProperties(raw)).withContext(String(raw)).toEqual({});
            }
        });
    });

    it('serializes to JSON, or null when empty', () => {
        expect(serializeUserProperties({ plan: 'pro' })).toBe('{"plan":"pro"}');
        expect(serializeUserProperties({})).toBeNull();
    });

    it('builds the { name: { value } } payload, or null when empty', () => {
        expect(toUserPropertiesPayload({ plan: 'pro', tier: 2 })).toEqual({ plan: { value: 'pro' }, tier: { value: 2 } });
        expect(toUserPropertiesPayload({})).toBeNull();
    });
});

import {
    MAX_USER_PROPERTIES,
    mergeUserProperties,
    parseStoredUserProperties,
    toUserPropertiesPayload,
    userPropertyNameProblem,
    userPropertyValueProblem
} from './user-properties';

describe('user properties', () => {
    describe('userPropertyNameProblem()', () => {
        it('accepts an ordinary name up to 24 characters', () => {
            expect(userPropertyNameProblem('plan')).toBeNull();
            expect(userPropertyNameProblem('a'.repeat(24))).toBeNull();
            expect(userPropertyNameProblem('Plan_Tier_2')).toBeNull();
        });

        it('rejects a name longer than 24 characters', () => {
            expect(userPropertyNameProblem('a'.repeat(25))).toContain('24');
        });

        it('rejects the reserved names', () => {
            for (const name of ['first_open_time', 'first_visit_time', 'last_deep_link_referrer', 'user_id', 'first_open_after_install']) {
                expect(userPropertyNameProblem(name)).withContext(name).toContain('reserved');
            }
        });

        it('rejects the reserved prefixes', () => {
            for (const name of ['_plan', 'firebase_plan', 'ga_plan', 'google_plan']) {
                expect(userPropertyNameProblem(name)).withContext(name).toContain('reserved prefix');
            }
        });

        it('rejects names that do not start with a letter or contain other characters', () => {
            expect(userPropertyNameProblem('1plan')).not.toBeNull();
            expect(userPropertyNameProblem('plan-tier')).not.toBeNull();
            expect(userPropertyNameProblem('plan tier')).not.toBeNull();
            expect(userPropertyNameProblem('')).not.toBeNull();
        });
    });

    describe('userPropertyValueProblem()', () => {
        it('accepts strings and numbers up to 36 characters', () => {
            expect(userPropertyValueProblem('p', 'x'.repeat(36))).toBeNull();
            expect(userPropertyValueProblem('p', 42)).toBeNull();
            expect(userPropertyValueProblem('p', 0)).toBeNull();
            expect(userPropertyValueProblem('p', '')).toBeNull();
        });

        it('rejects a value longer than 36 characters', () => {
            expect(userPropertyValueProblem('p', 'x'.repeat(37))).toContain('36');
        });

        it('counts code points, not UTF-16 units', () => {
            // 36 emoji: 36 characters to GA4, 72 to String#length.
            expect(userPropertyValueProblem('p', '😀'.repeat(36))).toBeNull();
            expect(userPropertyValueProblem('p', '😀'.repeat(37))).not.toBeNull();
        });

        it('rejects non-finite numbers and other types', () => {
            expect(userPropertyValueProblem('p', NaN)).not.toBeNull();
            expect(userPropertyValueProblem('p', Infinity)).not.toBeNull();
            expect(userPropertyValueProblem('p', true)).not.toBeNull();
            expect(userPropertyValueProblem('p', { a: 1 })).not.toBeNull();
        });
    });

    describe('mergeUserProperties()', () => {
        it('merges into the current map without mutating it', () => {
            const current = { plan: 'free' };
            const { properties, problems } = mergeUserProperties(current, { tier: 2 });

            expect(properties).toEqual({ plan: 'free', tier: 2 });
            expect(problems).toEqual([]);
            expect(current).toEqual({ plan: 'free' });
        });

        it('overwrites an existing property', () => {
            expect(mergeUserProperties({ plan: 'free' }, { plan: 'pro' }).properties).toEqual({ plan: 'pro' });
        });

        it('removes a property set to null', () => {
            expect(mergeUserProperties({ plan: 'free', tier: 2 }, { plan: null }).properties).toEqual({ tier: 2 });
        });

        it('drops invalid entries, keeps valid ones, and reports each drop', () => {
            const { properties, problems } = mergeUserProperties({}, {
                plan: 'pro',
                user_id: 'abc',
                [`a${'b'.repeat(24)}`]: 'x',
                long_value: 'x'.repeat(37)
            });

            expect(properties).toEqual({ plan: 'pro' });
            expect(problems.length).toBe(3);
        });

        it('caps the merged map at 25, keeping properties already held', () => {
            const current: Record<string, string> = {};
            for (let i = 0; i < MAX_USER_PROPERTIES; i++) {
                current[`p${i}`] = 'v';
            }

            const { properties, problems } = mergeUserProperties(current, { extra: 'v', p0: 'updated' });

            expect(Object.keys(properties).length).toBe(MAX_USER_PROPERTIES);
            expect(properties['extra']).toBeUndefined();
            // Updating a property already held does not count against the cap.
            expect(properties['p0']).toBe('updated');
            expect(problems.length).toBe(1);
        });

        it('ignores an undefined value instead of removing the property', () => {
            expect(mergeUserProperties({ plan: 'pro' }, { plan: undefined }).properties).toEqual({ plan: 'pro' });
        });

        it('applies the cap to names that exist on Object.prototype', () => {
            const current: Record<string, string> = {};
            for (let i = 0; i < MAX_USER_PROPERTIES; i++) {
                current[`p${i}`] = 'v';
            }

            const { properties, problems } = mergeUserProperties(current, { constructor: 'x', toString: 'y' });

            expect(Object.keys(properties).length).toBe(MAX_USER_PROPERTIES);
            expect(problems.length).toBe(2);
        });

        it('makes room for a new property once one is removed in the same call', () => {
            const current: Record<string, string> = {};
            for (let i = 0; i < MAX_USER_PROPERTIES; i++) {
                current[`p${i}`] = 'v';
            }

            const { properties } = mergeUserProperties(current, { p0: null, extra: 'v' });

            expect(properties['extra']).toBe('v');
            expect(Object.keys(properties).length).toBe(MAX_USER_PROPERTIES);
        });
    });

    describe('toUserPropertiesPayload()', () => {
        it('wraps each value in the Measurement Protocol shape', () => {
            expect(toUserPropertiesPayload({ plan: 'pro', tier: 2 })).toEqual({
                plan: { value: 'pro' },
                tier: { value: 2 }
            });
        });

        it('returns null for an empty map', () => {
            expect(toUserPropertiesPayload({})).toBeNull();
        });
    });

    describe('parseStoredUserProperties()', () => {
        it('reads a JSON string or a plain object', () => {
            expect(parseStoredUserProperties('{"plan":"pro"}')).toEqual({ plan: 'pro' });
            expect(parseStoredUserProperties({ plan: 'pro' })).toEqual({ plan: 'pro' });
        });

        it('returns an empty map for junk', () => {
            expect(parseStoredUserProperties(null)).toEqual({});
            expect(parseStoredUserProperties(undefined)).toEqual({});
            expect(parseStoredUserProperties('not json')).toEqual({});
            expect(parseStoredUserProperties('[1,2]')).toEqual({});
            expect(parseStoredUserProperties(42)).toEqual({});
        });

        it('drops stored entries that would be rejected', () => {
            expect(parseStoredUserProperties({ plan: 'pro', user_id: 'x', bad: { nested: true } })).toEqual({ plan: 'pro' });
        });
    });
});

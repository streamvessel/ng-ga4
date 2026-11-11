/** A value for `setUserProperties()`. `null` removes the property. */
export type NgGa4UserPropertyValue = string | number | null;

export type UserProperties = Record<string, string | number>;

/** The request-level `user_properties` field: `{ name: { value } }`. */
export type Ga4UserPropertiesPayload = Record<string, { value: string | number }>;

/**
 * A validated change to the property map: `clear` empties it first, then each
 * value is set, or removed when `null`. A Map, so a `__proto__` key stays data.
 */
export interface UserPropertyUpdate {
    clear: boolean;
    values: Map<string, string | number | null>;
}

// https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events#limitations
export const MAX_USER_PROPERTIES = 25;
const MAX_NAME_LENGTH = 24;
const MAX_VALUE_LENGTH = 36;

// https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#reserved_names
const RESERVED_NAMES = new Set([
    'first_open_time',
    'first_visit_time',
    'last_deep_link_referrer',
    'user_id',
    'first_open_after_install'
]);
const RESERVED_PREFIXES = ['_', 'firebase_', 'ga_', 'google_'];

/** Why a name is unusable, or `null` if it is fine. */
export function userPropertyNameProblem(name: string): string | null {
    // Case-insensitive: a wrongly accepted name is silently lost by GA4, a
    // wrongly rejected one only costs a rename.
    const lower = name.toLowerCase();
    const prefix = RESERVED_PREFIXES.find(p => lower.startsWith(p));
    if (prefix) {
        return `name "${name}" uses the reserved prefix "${prefix}"`;
    }
    if (RESERVED_NAMES.has(name)) {
        return `name "${name}" is reserved`;
    }
    if (name.length > MAX_NAME_LENGTH) {
        return `name "${name}" is longer than ${MAX_NAME_LENGTH} characters`;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        return `name "${name}" must start with a letter and contain only letters, digits and underscores`;
    }
    return null;
}

/** Why a value is unusable, or `null` if it is fine. */
export function userPropertyValueProblem(name: string, value: unknown): string | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return `value of "${name}" is not a finite number`;
        }
    } else if (typeof value !== 'string') {
        return `value of "${name}" must be a string or a number`;
    }
    // Code points, as GA4 counts them: an emoji is one character, not two.
    if ([...String(value)].length > MAX_VALUE_LENGTH) {
        return `value of "${name}" is longer than ${MAX_VALUE_LENGTH} characters`;
    }
    return null;
}

export function emptyUserPropertyUpdate(): UserPropertyUpdate {
    return { clear: false, values: new Map() };
}

/**
 * Fold one `setUserProperties()` argument into `update`, dropping invalid
 * entries. `undefined` values are ignored, so `{ plan: user?.plan }` before
 * the user loads keeps a stored plan. Returns one message per dropped entry.
 */
export function foldUserPropertyUpdate(
    update: UserPropertyUpdate,
    properties: Readonly<Record<string, NgGa4UserPropertyValue | undefined>> | null
): string[] {
    if (properties === null) {
        update.clear = true;
        update.values.clear();
        return [];
    }
    const problems: string[] = [];
    for (const [name, value] of Object.entries(properties)) {
        if (value === undefined) {
            continue;
        }
        const problem = value === null ? null : userPropertyNameProblem(name) ?? userPropertyValueProblem(name, value);
        if (problem) {
            problems.push(problem);
        } else {
            update.values.set(name, value);
        }
    }
    return problems;
}

/**
 * Apply `update` to `current` without mutating either. The 25-property cap
 * keeps properties already held, so a later call never evicts an earlier one.
 */
export function applyUserPropertyUpdate(
    current: Readonly<UserProperties>,
    update: UserPropertyUpdate
): { properties: UserProperties; problems: string[] } {
    const properties: UserProperties = update.clear ? {} : { ...current };
    const problems: string[] = [];
    for (const [name, value] of update.values) {
        if (value === null) {
            delete properties[name];
        } else if (Object.hasOwn(properties, name) || Object.keys(properties).length < MAX_USER_PROPERTIES) {
            properties[name] = value;
        } else {
            problems.push(`"${name}" exceeds the limit of ${MAX_USER_PROPERTIES} user properties`);
        }
    }
    return { properties, problems };
}

/** The stored form: JSON, or `null` when there is nothing to store. */
export function serializeUserProperties(properties: Readonly<UserProperties>): string | null {
    return Object.keys(properties).length ? JSON.stringify(properties) : null;
}

/**
 * Read a stored value. Storage is shared with other code on the origin, so it
 * is re-validated and anything invalid is dropped silently.
 */
export function parseStoredUserProperties(raw: unknown): UserProperties {
    let value: unknown;
    try {
        value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return {};
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {};
    }
    const update = emptyUserPropertyUpdate();
    foldUserPropertyUpdate(update, value as Record<string, NgGa4UserPropertyValue>);
    for (const [name, v] of update.values) {
        if (v === null) {
            update.values.delete(name);
        }
    }
    return applyUserPropertyUpdate({}, update).properties;
}

/** The request-level payload, or `null` when there is nothing to send. */
export function toUserPropertiesPayload(properties: Readonly<UserProperties>): Ga4UserPropertiesPayload | null {
    const entries = Object.entries(properties);
    return entries.length ? Object.fromEntries(entries.map(([name, value]) => [name, { value }])) : null;
}

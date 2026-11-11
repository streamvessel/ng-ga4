/**
 * A user property value as accepted by `setUserProperties()`. `null` removes
 * that one property; it is never sent.
 */
export type NgGa4UserPropertyValue = string | number | null;

/** The request-level `user_properties` field: `{ name: { value } }`. */
export type Ga4UserPropertiesPayload = Record<string, { value: string | number }>;

// Measurement Protocol limits for user properties.
// https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#reserved_names
// https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events#limitations
export const MAX_USER_PROPERTIES = 25;
const MAX_USER_PROPERTY_NAME_LENGTH = 24;
const MAX_USER_PROPERTY_VALUE_LENGTH = 36;

const RESERVED_USER_PROPERTY_NAMES = new Set([
    'first_open_time',
    'first_visit_time',
    'last_deep_link_referrer',
    'user_id',
    'first_open_after_install'
]);

// `_` is covered by the leading-letter rule in the name pattern below; listed
// for the error message only.
const RESERVED_USER_PROPERTY_PREFIXES = ['_', 'firebase_', 'ga_', 'google_'];

/** Why a user property name is unusable, or `null` if it is fine. */
export function userPropertyNameProblem(name: string): string | null {
    // Case-insensitive: Google lists the prefixes in lower case without saying
    // whether case matters, and wrongly accepting a name loses the property
    // silently, while wrongly rejecting one only costs a rename and a warning.
    const lower = name.toLowerCase();
    const prefix = RESERVED_USER_PROPERTY_PREFIXES.find(p => lower.startsWith(p));
    if (prefix) {
        return `name "${name}" uses the reserved prefix "${prefix}"`;
    }
    if (RESERVED_USER_PROPERTY_NAMES.has(name)) {
        return `name "${name}" is reserved`;
    }
    if (name.length > MAX_USER_PROPERTY_NAME_LENGTH) {
        return `name "${name}" is longer than ${MAX_USER_PROPERTY_NAME_LENGTH} characters`;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        return `name "${name}" must start with a letter and contain only letters, digits and underscores`;
    }
    return null;
}

/** Why a user property value is unusable, or `null` if it is fine. */
export function userPropertyValueProblem(name: string, value: unknown): string | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return `value of "${name}" is not a finite number`;
        }
    } else if (typeof value !== 'string') {
        return `value of "${name}" must be a string or a number`;
    }
    // Counted in code points, like the user ID check: an emoji is one
    // character to GA4 but two UTF-16 units to `.length`.
    if ([...String(value)].length > MAX_USER_PROPERTY_VALUE_LENGTH) {
        return `value of "${name}" is longer than ${MAX_USER_PROPERTY_VALUE_LENGTH} characters`;
    }
    return null;
}

/**
 * Merge `updates` into `current`, dropping anything the Measurement Protocol
 * would reject. Returns the new map and one message per dropped entry; never
 * mutates its inputs.
 *
 * A `null` value removes that property; an `undefined` one is ignored, so
 * `{ plan: user?.plan }` before the user has loaded does not delete a stored
 * plan. The 25-property cap is applied to the
 * merged result: properties already held always win over new ones, so a later
 * call can never silently evict an earlier property.
 */
export function mergeUserProperties(
    current: Readonly<Record<string, string | number>>,
    updates: Readonly<Record<string, unknown>>
): { properties: Record<string, string | number>; problems: string[] } {
    const properties: Record<string, string | number> = { ...current };
    const problems: string[] = [];
    for (const name of Object.keys(updates)) {
        const value = updates[name];
        if (value === undefined) {
            continue;
        }
        if (value === null) {
            delete properties[name];
            continue;
        }
        const problem = userPropertyNameProblem(name) ?? userPropertyValueProblem(name, value);
        if (problem) {
            problems.push(problem);
            continue;
        }
        if (!Object.hasOwn(properties, name) && Object.keys(properties).length >= MAX_USER_PROPERTIES) {
            problems.push(`"${name}" exceeds the limit of ${MAX_USER_PROPERTIES} user properties`);
            continue;
        }
        properties[name] = value as string | number;
    }
    return { properties, problems };
}

/** The request-level payload, or `null` when there is nothing to send. */
export function toUserPropertiesPayload(
    properties: Readonly<Record<string, string | number>>
): Ga4UserPropertiesPayload | null {
    const entries = Object.entries(properties);
    return entries.length
        ? Object.fromEntries(entries.map(([name, value]) => [name, { value }]))
        : null;
}

/**
 * Re-validate a stored map. Storage is shared with whatever else runs on the
 * origin and with older versions of this library, so it is never trusted;
 * anything malformed is dropped silently, since the caller who set it is long
 * gone and a warning on every load would be noise.
 */
export function parseStoredUserProperties(raw: unknown): Record<string, string | number> {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return {};
        }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {};
    }
    return mergeUserProperties({}, value as Record<string, unknown>).properties;
}

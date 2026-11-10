// Client-side enforcement of the Measurement Protocol's documented naming rules
// and limits. /mp/collect answers 204 for a payload it is about to discard, so
// without this a typo'd event name is permanent, silent data loss.
//
// https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#reserved_names
//
// Pure functions with no Angular dependency, so the user_properties validation
// can reuse the same building blocks.

export const MAX_EVENT_NAME_LENGTH = 40;
export const MAX_PARAM_NAME_LENGTH = 40;
export const MAX_PARAMS_PER_EVENT = 25;
export const MAX_PARAM_VALUE_LENGTH = 100;

// GA4 documents larger limits for these page parameters than for the rest.
const PARAM_VALUE_LENGTH_OVERRIDES: Readonly<Record<string, number>> = {
    page_location: 1000,
    page_referrer: 420,
    page_title: 300
};

// Names the Measurement Protocol reserves for its own use: accepted with 2xx and dropped.
const RESERVED_EVENT_NAMES = new Set([
    'ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'ad_reward', 'adunit_exposure',
    'app_clear_data', 'app_exception', 'app_install', 'app_remove', 'app_store_refund',
    'app_update', 'app_upgrade', 'dynamic_link_app_open', 'dynamic_link_app_update',
    'dynamic_link_first_open', 'error', 'firebase_campaign', 'first_open', 'first_visit',
    'os_update', 'session_start', 'user_engagement'
]);
const RESERVED_EVENT_NAME_PREFIXES = ['firebase_in_app_message_', 'notification_'];

// Valid only on an App stream; a web stream — which is all this library sends to — drops them.
const APP_ONLY_EVENT_NAMES = new Set(['ad_impression', 'in_app_purchase', 'screen_view']);

const RESERVED_PARAM_NAMES = new Set(['firebase_conversion']);

// `_`, `ga_`, `google_` and `gtag.` cannot pass the character rule below anyway
// (a name must start with a letter and contain no dots), but they are listed so
// the warning names the rule actually broken rather than a generic one.
const RESERVED_NAME_PREFIXES = ['_', 'firebase_', 'ga_', 'google_', 'gtag.'];

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Why GA4 would discard an event with this name, or `null` if it would not.
 */
export function eventNameProblem(name: unknown): string | null {
    if (typeof name !== 'string' || name.length === 0) {
        return 'event name must be a non-empty string';
    }
    if (name.length > MAX_EVENT_NAME_LENGTH) {
        return `event name "${name}" is ${name.length} characters; the limit is ${MAX_EVENT_NAME_LENGTH}`;
    }
    if (RESERVED_EVENT_NAMES.has(name)) {
        return `event name "${name}" is reserved by GA4`;
    }
    const prefix = RESERVED_NAME_PREFIXES.find(p => name.startsWith(p));
    if (prefix) {
        return `event name "${name}" uses the reserved prefix "${prefix}"`;
    }
    if (!NAME_PATTERN.test(name)) {
        return `event name "${name}" must start with a letter and contain only letters, digits and underscores`;
    }
    const reservedPrefix = RESERVED_EVENT_NAME_PREFIXES.find(p => name.startsWith(p));
    if (reservedPrefix) {
        return `event name "${name}" uses the reserved prefix "${reservedPrefix}"`;
    }
    if (APP_ONLY_EVENT_NAMES.has(name)) {
        return `event name "${name}" is only accepted on an App stream and is dropped on a web stream`;
    }
    return null;
}

/**
 * Why GA4 would discard a parameter with this name, or `null` if it would not.
 */
export function paramNameProblem(name: string): string | null {
    if (name.length === 0) {
        return 'parameter name must not be empty';
    }
    if (name.length > MAX_PARAM_NAME_LENGTH) {
        return `parameter name "${name}" is ${name.length} characters; the limit is ${MAX_PARAM_NAME_LENGTH}`;
    }
    if (RESERVED_PARAM_NAMES.has(name)) {
        return `parameter name "${name}" is reserved by GA4`;
    }
    const prefix = RESERVED_NAME_PREFIXES.find(p => name.startsWith(p));
    if (prefix) {
        return `parameter name "${name}" uses the reserved prefix "${prefix}"`;
    }
    if (!NAME_PATTERN.test(name)) {
        return `parameter name "${name}" must start with a letter and contain only letters, digits and underscores`;
    }
    return null;
}

/**
 * Why this parameter value is over GA4's length limit, or `null` if it is not.
 * Advisory only: the limit is 500 on GA4 360 properties, so a longer value is
 * not necessarily lost and is never removed by this library.
 */
export function paramValueProblem(name: string, value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const limit = PARAM_VALUE_LENGTH_OVERRIDES[name] ?? MAX_PARAM_VALUE_LENGTH;
    if (value.length <= limit) {
        return null;
    }
    return `parameter "${name}" value is ${value.length} characters; ` +
        `the limit is ${limit} on a standard GA4 property`;
}

export interface Ga4ParamsValidation {
    /** The params with every invalidly named one removed. */
    params: Record<string, unknown>;
    /** Names removed from `params` because GA4 would discard them. */
    dropped: string[];
    /** One message per rule broken, dropped params included. */
    problems: string[];
}

/**
 * Validates event params. Params GA4 would discard (bad or reserved names) are
 * removed from the result; a value over the length limit or a param count over
 * the limit is reported but left as it is, since what GA4 does with it depends
 * on the property. `undefined` values are skipped: JSON serialisation drops them.
 */
export function validateEventParams(params: Record<string, unknown>): Ga4ParamsValidation {
    const result: Record<string, unknown> = {};
    const dropped: string[] = [];
    const problems: string[] = [];
    let count = 0;
    for (const name of Object.keys(params)) {
        const value = params[name];
        if (value === undefined) {
            continue;
        }
        const nameProblem = paramNameProblem(name);
        if (nameProblem) {
            dropped.push(name);
            problems.push(`${nameProblem}; it was removed`);
            continue;
        }
        const valueProblem = paramValueProblem(name, value);
        if (valueProblem) {
            problems.push(valueProblem);
        }
        result[name] = value;
        count++;
    }
    if (count > MAX_PARAMS_PER_EVENT) {
        problems.push(`event has ${count} parameters; the limit is ${MAX_PARAMS_PER_EVENT}`);
    }
    return { params: result, dropped, problems };
}

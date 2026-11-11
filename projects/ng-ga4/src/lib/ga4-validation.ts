// Client-side enforcement of the Measurement Protocol's documented naming rules
// and limits. /mp/collect answers 204 for a payload it is about to discard, so
// without this a typo'd event name is permanent, silent data loss.
//
// https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#reserved_names
//
// Pure functions with no Angular dependency. Names of every kind GA4 accepts
// follow the same shape, so user properties (#19) can be checked by passing
// nameProblem() their own Ga4NameRules.

const MAX_NAME_LENGTH = 40;
const MAX_PARAMS_PER_EVENT = 25;
const MAX_PARAM_VALUE_LENGTH = 100;

// GA4 documents larger limits for these page parameters than for the rest.
const PARAM_VALUE_LENGTH_OVERRIDES: Readonly<Record<string, number>> = {
    page_location: 1000,
    page_referrer: 420,
    page_title: 300
};

/**
 * Prefixes GA4 reserves for its own names. `_` and `gtag.` could not pass the
 * character rule anyway, but are listed so the warning names the rule broken.
 */
export const RESERVED_NAME_PREFIXES: readonly string[] = ['_', 'firebase_', 'ga_', 'google_', 'gtag.'];

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface Ga4NameRules {
    /** How the name is described in messages, e.g. `'event name'`. */
    label: string;
    maxLength: number;
    reservedNames: ReadonlySet<string>;
    reservedPrefixes: readonly string[];
}

const EVENT_NAME_RULES: Ga4NameRules = {
    label: 'event name',
    maxLength: MAX_NAME_LENGTH,
    reservedNames: new Set([
        'ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'ad_reward', 'adunit_exposure',
        'app_clear_data', 'app_exception', 'app_install', 'app_remove', 'app_store_refund',
        'app_update', 'app_upgrade', 'dynamic_link_app_open', 'dynamic_link_app_update',
        'dynamic_link_first_open', 'error', 'firebase_campaign', 'first_open', 'first_visit',
        'os_update', 'session_start', 'user_engagement'
    ]),
    // firebase_in_app_message_* is reserved too, and covered by firebase_.
    reservedPrefixes: [...RESERVED_NAME_PREFIXES, 'notification_']
};

const PARAM_NAME_RULES: Ga4NameRules = {
    label: 'parameter name',
    maxLength: MAX_NAME_LENGTH,
    reservedNames: new Set(['firebase_conversion']),
    reservedPrefixes: RESERVED_NAME_PREFIXES
};

// Valid only on an App stream; a web stream — which is all this library sends to — drops them.
const APP_ONLY_EVENT_NAMES = new Set(['ad_impression', 'in_app_purchase', 'screen_view']);

/**
 * Why GA4 would discard a name under these rules, or `null` if it would not.
 * Exact reserved names are checked before prefixes, so the message names the
 * most specific rule broken.
 */
export function nameProblem(name: unknown, rules: Ga4NameRules): string | null {
    const { label } = rules;
    if (typeof name !== 'string' || name.length === 0) {
        return `${label} must be a non-empty string`;
    }
    if (name.length > rules.maxLength) {
        return `${label} "${name}" is ${name.length} characters; the limit is ${rules.maxLength}`;
    }
    if (rules.reservedNames.has(name)) {
        return `${label} "${name}" is reserved by GA4`;
    }
    for (const prefix of rules.reservedPrefixes) {
        if (name.startsWith(prefix)) {
            return `${label} "${name}" uses the reserved prefix "${prefix}"`;
        }
    }
    if (!NAME_PATTERN.test(name)) {
        return `${label} "${name}" must start with a letter and contain only letters, digits and underscores`;
    }
    return null;
}

/**
 * Why GA4 would discard an event with this name, or `null` if it would not.
 */
export function eventNameProblem(name: unknown): string | null {
    const problem = nameProblem(name, EVENT_NAME_RULES);
    if (problem === null && APP_ONLY_EVENT_NAMES.has(name as string)) {
        return `event name "${name}" is only accepted on an App stream and is dropped on a web stream`;
    }
    return problem;
}

/**
 * Why GA4 would discard a parameter with this name, or `null` if it would not.
 */
export function paramNameProblem(name: string): string | null {
    return nameProblem(name, PARAM_NAME_RULES);
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
    /** One message per rule broken. Empty when `report` is false. */
    problems: string[];
}

/**
 * Validates event params. Params GA4 would discard (bad or reserved names) are
 * removed from the result; a value over the length limit or a param count over
 * the limit is left as it is, since what GA4 does with it depends on the
 * property. `undefined` values are skipped: JSON serialisation drops them.
 *
 * With `report` false, only the removal happens: the advisory checks, whose
 * sole output is a message, are skipped and nothing is collected.
 */
export function validateEventParams(params: Record<string, unknown>, report: boolean): Ga4ParamsValidation {
    const result: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const name of Object.keys(params)) {
        const value = params[name];
        if (value === undefined) {
            continue;
        }
        const nameIssue = paramNameProblem(name);
        if (nameIssue) {
            if (report) {
                problems.push(`${nameIssue}; it was removed`);
            }
            continue;
        }
        if (report) {
            const valueIssue = paramValueProblem(name, value);
            if (valueIssue) {
                problems.push(valueIssue);
            }
        }
        result[name] = value;
    }
    const count = Object.keys(result).length;
    if (report && count > MAX_PARAMS_PER_EVENT) {
        problems.push(`event has ${count} parameters; the limit is ${MAX_PARAMS_PER_EVENT}`);
    }
    return { params: result, problems };
}

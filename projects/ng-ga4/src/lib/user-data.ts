// User-provided data (`user_data`) for Google Ads enhanced conversions.
// GA4 matches on the hash, so any drift in normalisation silently breaks matching.
// Email, phone and street follow the Measurement Protocol "user-provided data"
// reference (https://developers.google.com/analytics/devguides/collection/ga4/uid-data).
// Names, city, region, country and pre-hashed input follow what gtag.js itself
// does, since the reference leaves "symbol characters" undefined.

/**
 * A postal address. Name and street are hashed before they are sent; city,
 * region, postal code and country are sent as-is (normalised), as the
 * Measurement Protocol requires. A `sha256*` field takes a value you have
 * already normalised and hashed yourself, and replaces the raw field.
 */
export interface NgGa4UserAddress {
    firstName?: string;
    lastName?: string;
    street?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    /** ISO 3166-1 alpha-2, e.g. `'US'`. */
    country?: string;
    sha256FirstName?: string;
    sha256LastName?: string;
    sha256Street?: string;
}

/**
 * User-provided data. Raw values are normalised and hashed with SHA-256 before
 * they are sent. A `sha256*` field takes hex digests you computed yourself and
 * replaces its raw counterpart, as in gtag.js. Any value that already is a
 * 64-character hex digest is sent as-is; any other is normalised and hashed.
 */
export interface NgGa4UserData {
    /** One address, or up to 3. */
    email?: string | string[];
    /** One number, or up to 3. Include the country code (E.164), e.g. `+15555555555`. */
    phone?: string | string[];
    /** Already normalised and hashed: hex SHA-256. Replaces `email`. */
    sha256EmailAddress?: string | string[];
    /** Already normalised (E.164) and hashed: hex SHA-256. Replaces `phone`. */
    sha256PhoneNumber?: string | string[];
    /** One address, or up to 2. */
    address?: NgGa4UserAddress | NgGa4UserAddress[];
}

export interface Ga4UserAddressPayload {
    sha256_first_name?: string;
    sha256_last_name?: string;
    sha256_street?: string;
    city?: string;
    region?: string;
    postal_code?: string;
    country?: string;
}

/** The MP payload projection: never a raw email, phone, name or street. */
export interface Ga4UserDataPayload {
    sha256_email_address?: string[];
    sha256_phone_number?: string[];
    address?: Ga4UserAddressPayload[];
}

/** The MP limits. */
const MAX_EMAILS_OR_PHONES = 3;
const MAX_ADDRESSES = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Lowercase, remove all spaces, and drop the periods in the local part of
 * gmail.com / googlemail.com addresses. Returns `null` for anything without a
 * local part and a domain, so a placeholder such as 'N/A' never takes a slot.
 */
export function normalizeEmail(email: string): string | null {
    const normalized = email.replace(/\s+/g, '').toLowerCase();
    const at = normalized.lastIndexOf('@');
    if (at <= 0 || at === normalized.length - 1) {
        return null;
    }
    const domain = normalized.slice(at + 1);
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
        return normalized.slice(0, at).replace(/\./g, '') + '@' + domain;
    }
    return normalized;
}

/**
 * Strip every non-digit and add a `+` prefix. A leading `00` international
 * prefix is dropped (no E.164 number starts with 0). We cannot infer a missing
 * country code, so callers must pass E.164. Returns `null` when no digits remain.
 */
export function normalizePhone(phone: string): string | null {
    const digits = phone.replace(/\D/g, '').replace(/^00/, '');
    return digits ? `+${digits}` : null;
}

// gtag.js's own list of what it strips from names, city and region: digits and
// these ASCII symbols. Notably not `'`, so "O'Brien" keeps its apostrophe.
const GTAG_STRIPPED = /[0-9`~!@#$%^&*()_\-+=:;<>,.?|/\\[\]]/g;

/** First and last name, as gtag.js: remove all whitespace, digits and symbols, lowercase. */
export function normalizeName(value: string): string | null {
    return value.replace(/\s/g, '').replace(GTAG_STRIPPED, '').toLowerCase() || null;
}

/** City and region, as gtag.js: remove digits and symbols, lowercase, trim. */
export function normalizePlace(value: string): string | null {
    return value.replace(GTAG_STRIPPED, '').toLowerCase().trim() || null;
}

/** Street: remove symbols (digits stay), lowercase, trim. */
export function normalizeStreet(value: string): string | null {
    return value.replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').trim().toLowerCase() || null;
}

/** Postal code and country, as gtag.js: remove `.` and `~`, trim. Case is left alone. */
export function normalizePostalCodeOrCountry(value: string): string | null {
    return value.replace(/[.~]/g, '').trim() || null;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `value`. */
export async function sha256Hex(value: string, subtle: SubtleCrypto): Promise<string> {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalise and hash. Empty values are skipped, duplicates collapse, and each
 * list is capped at the MP limit, with a warning when something is cut. Returns
 * `null` when nothing is left to send, so the key is omitted from the body.
 */
export async function hashUserData(data: NgGa4UserData, subtle: SubtleCrypto): Promise<Ga4UserDataPayload | null> {
    const [emails, phones, addresses] = await Promise.all([
        hashList('email', data.email, data.sha256EmailAddress, normalizeEmail, subtle),
        hashList('phone', data.phone, data.sha256PhoneNumber, normalizePhone, subtle),
        Promise.all(toList(data.address).map(address => hashAddress(address, subtle)))
    ]);
    const usable = addresses.filter((a): a is Ga4UserAddressPayload => a !== null);
    const payload: Ga4UserDataPayload = {
        ...(emails.length ? { sha256_email_address: emails } : {}),
        ...(phones.length ? { sha256_phone_number: phones } : {}),
        ...(usable.length ? { address: cap('address', usable, MAX_ADDRESSES) } : {})
    };
    return Object.keys(payload).length ? payload : null;
}

async function hashList(
    field: string,
    raw: string | string[] | undefined,
    preHashed: string | string[] | undefined,
    normalize: (value: string) => string | null,
    subtle: SubtleCrypto
): Promise<string[]> {
    const source = toList(preHashed).length ? preHashed : raw;
    const digests = await Promise.all(toList(source).map(v => digestOf(v, normalize, subtle)));
    return cap(field, unique(digests), MAX_EMAILS_OR_PHONES);
}

/**
 * A value that already is a hex SHA-256 digest is taken as-is (lowercased);
 * anything else is normalised and hashed, so even a raw value passed in a
 * `sha256*` field never goes out unhashed. This is what gtag.js does.
 */
async function digestOf(value: unknown, normalize: (value: string) => string | null, subtle: SubtleCrypto): Promise<string | null> {
    if (typeof value !== 'string') {
        // Untyped callers can pass anything; skip rather than throw.
        return null;
    }
    const trimmed = value.trim();
    if (SHA256_HEX.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    const normalized = normalize(trimmed);
    return normalized ? sha256Hex(normalized, subtle) : null;
}

const HASHED_ADDRESS_FIELDS = [
    ['firstName', 'sha256FirstName', 'sha256_first_name', normalizeName],
    ['lastName', 'sha256LastName', 'sha256_last_name', normalizeName],
    ['street', 'sha256Street', 'sha256_street', normalizeStreet]
] as const;

const PLAIN_ADDRESS_FIELDS = [
    ['city', 'city', normalizePlace],
    ['region', 'region', normalizePlace],
    ['postalCode', 'postal_code', normalizePostalCodeOrCountry],
    ['country', 'country', normalizePostalCodeOrCountry]
] as const;

async function hashAddress(address: NgGa4UserAddress, subtle: SubtleCrypto): Promise<Ga4UserAddressPayload | null> {
    if (!address || typeof address !== 'object') {
        return null;
    }
    const payload: Ga4UserAddressPayload = {};
    for (const [rawKey, hashedKey, payloadKey, normalize] of HASHED_ADDRESS_FIELDS) {
        // A `sha256*` field replaces the raw one, as in gtag.js.
        const value = await digestOf(address[hashedKey] || address[rawKey], normalize, subtle);
        if (value) {
            payload[payloadKey] = value;
        }
    }
    for (const [rawKey, payloadKey, normalize] of PLAIN_ADDRESS_FIELDS) {
        const value = normalizeIfString(address[rawKey], normalize);
        if (value) {
            payload[payloadKey] = value;
        }
    }
    return Object.keys(payload).length ? payload : null;
}

// Untyped callers can pass anything; skip rather than throw.
function normalizeIfString(value: unknown, normalize: (value: string) => string | null): string | null {
    return typeof value === 'string' ? normalize(value) : null;
}

function toList<T>(value: T | T[] | undefined): T[] {
    return ([] as T[]).concat(value ?? []);
}

function unique(values: Array<string | null>): string[] {
    return [...new Set(values.filter((v): v is string => !!v))];
}

function cap<T>(field: string, values: T[], max: number): T[] {
    if (values.length > max) {
        console.warn(`[ng-ga4] user_data accepts at most ${max} ${field} values; sending the first ${max}.`);
    }
    return values.slice(0, max);
}

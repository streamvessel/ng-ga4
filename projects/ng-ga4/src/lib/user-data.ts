// User-provided data (`user_data`) for Google Ads enhanced conversions. Matching
// is on the hash, so normalisation must match Google's exactly: email, phone and
// street per https://developers.google.com/analytics/devguides/collection/ga4/uid-data,
// the rest as gtag.js does it, since the reference leaves "symbols" undefined.

/**
 * A postal address. Name and street are hashed; city, region, postal code and
 * country are sent normalised but unhashed. A `sha256*` field replaces its raw
 * counterpart.
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
 * User-provided data, normalised and SHA-256 hashed before sending. Values that
 * already are 64-character hex digests are sent as-is.
 */
export interface NgGa4UserData {
    /** Up to 3. */
    email?: string | string[];
    /** Up to 3. Include the country code (E.164), e.g. `+15555555555`. */
    phone?: string | string[];
    /** Hex SHA-256 of the normalised value. Replaces `email`. */
    sha256EmailAddress?: string | string[];
    /** Hex SHA-256 of the normalised value. Replaces `phone`. */
    sha256PhoneNumber?: string | string[];
    /** Up to 2. */
    address?: NgGa4UserAddress | NgGa4UserAddress[];
}

interface Ga4UserAddressPayload {
    sha256_first_name?: string;
    sha256_last_name?: string;
    sha256_street?: string;
    city?: string;
    region?: string;
    postal_code?: string;
    country?: string;
}

export interface Ga4UserDataPayload {
    sha256_email_address?: string[];
    sha256_phone_number?: string[];
    address?: Ga4UserAddressPayload[];
}

const MAX_EMAILS_OR_PHONES = 3;
const MAX_ADDRESSES = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Returns `null` unless it looks like `local@domain`, so placeholders like 'N/A' are skipped. */
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

/** E.164 expected; a leading `00` is treated as `+`. */
export function normalizePhone(phone: string): string | null {
    const digits = phone.replace(/\D/g, '').replace(/^00/, '');
    return digits ? `+${digits}` : null;
}

// gtag.js's strip list for names, city and region. Excludes `'`, so O'Brien keeps it.
const GTAG_STRIPPED = /[0-9`~!@#$%^&*()_\-+=:;<>,.?|/\\[\]]/g;

export function normalizeName(value: string): string | null {
    return value.replace(/\s/g, '').replace(GTAG_STRIPPED, '').toLowerCase() || null;
}

export function normalizePlace(value: string): string | null {
    return value.replace(GTAG_STRIPPED, '').toLowerCase().trim() || null;
}

export function normalizeStreet(value: string): string | null {
    return value.replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').trim().toLowerCase() || null;
}

export function normalizePostalCodeOrCountry(value: string): string | null {
    return value.replace(/[.~]/g, '').trim() || null;
}

export async function sha256Hex(value: string, subtle: SubtleCrypto): Promise<string> {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns `null` when nothing usable is left. Never rejects: without
 * `crypto.subtle` (insecure context) or on a hashing failure it warns and
 * returns `null`, so raw values are never sent instead.
 */
export async function hashUserData(data: NgGa4UserData, subtle: SubtleCrypto | undefined): Promise<Ga4UserDataPayload | null> {
    if (!subtle) {
        console.warn('[ng-ga4] setUserData() needs crypto.subtle (a secure context); user_data will not be sent.');
        return null;
    }
    try {
        const [emails, phones, addresses] = await Promise.all([
            hashList('email', preferHashed(data.sha256EmailAddress, data.email), normalizeEmail, subtle),
            hashList('phone', preferHashed(data.sha256PhoneNumber, data.phone), normalizePhone, subtle),
            Promise.all(toList(data.address).map(address => hashAddress(address, subtle)))
        ]);
        const usable = addresses.filter((a): a is Ga4UserAddressPayload => a !== null);
        const payload: Ga4UserDataPayload = {
            ...(emails.length ? { sha256_email_address: emails } : {}),
            ...(phones.length ? { sha256_phone_number: phones } : {}),
            ...(usable.length ? { address: cap('address', usable, MAX_ADDRESSES) } : {})
        };
        return Object.keys(payload).length ? payload : null;
    } catch (err) {
        console.warn('[ng-ga4] Hashing user_data failed; it will not be sent.', err);
        return null;
    }
}

/** A `sha256*` field replaces its raw counterpart, as in gtag.js. */
function preferHashed<T>(hashed: T | T[] | undefined, raw: T | T[] | undefined): T | T[] | undefined {
    return toList(hashed).some(Boolean) ? hashed : raw;
}

async function hashList(
    field: string,
    values: string | string[] | undefined,
    normalize: (value: string) => string | null,
    subtle: SubtleCrypto
): Promise<string[]> {
    const digests = await Promise.all(toList(values).map(v => digestOf(v, normalize, subtle)));
    return cap(field, unique(digests), MAX_EMAILS_OR_PHONES);
}

/**
 * Hex digests pass through; anything else is normalised and hashed, so a raw
 * value in a `sha256*` field is never sent raw.
 */
async function digestOf(value: unknown, normalize: (value: string) => string | null, subtle: SubtleCrypto): Promise<string | null> {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (SHA256_HEX.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    const normalized = trimmed ? normalize(trimmed) : null;
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
    const hashed = await Promise.all(HASHED_ADDRESS_FIELDS.map(([rawKey, hashedKey, , normalize]) =>
        digestOf(preferHashed(address[hashedKey], address[rawKey]), normalize, subtle)));
    HASHED_ADDRESS_FIELDS.forEach(([, , payloadKey], i) => {
        if (hashed[i]) {
            payload[payloadKey] = hashed[i]!;
        }
    });
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

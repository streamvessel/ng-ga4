// User-provided data (`user_data`) for Google Ads enhanced conversions.
// Normalisation follows the Measurement Protocol "user-provided data" reference
// (https://developers.google.com/analytics/devguides/collection/ga4/uid-data):
// GA4 matches on the hash, so any drift from these rules silently breaks matching.

/** Raw, unhashed user-provided data. Hashed with SHA-256 before it is sent. */
export interface NgGa4UserData {
    /** One address, or up to 3. */
    email?: string | string[];
    /** One number, or up to 3. Include the country code (E.164), e.g. `+15555555555`. */
    phone?: string | string[];
}

/** The MP payload projection: hex-encoded SHA-256 digests only. */
export interface Ga4UserDataPayload {
    sha256_email_address?: string[];
    sha256_phone_number?: string[];
}

/** The MP limit for both email and phone. */
const MAX_USER_DATA_VALUES = 3;

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

/** Lowercase hex SHA-256 of the UTF-8 bytes of `value`. */
export async function sha256Hex(value: string, subtle: SubtleCrypto): Promise<string> {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalise and hash. Empty values are skipped, duplicates (after normalisation)
 * collapse, and each list is capped at {@link MAX_USER_DATA_VALUES}, with a
 * warning when something is cut. Returns `null` when nothing is left to send,
 * so the key is omitted from the body entirely.
 */
export async function hashUserData(data: NgGa4UserData, subtle: SubtleCrypto): Promise<Ga4UserDataPayload | null> {
    const hashAll = (values: string[]) => values.length ? Promise.all(values.map(v => sha256Hex(v, subtle))) : undefined;
    const [emails, phones] = await Promise.all([
        hashAll(prepare('email', data.email, normalizeEmail)),
        hashAll(prepare('phone', data.phone, normalizePhone))
    ]);
    if (!emails && !phones) {
        return null;
    }
    return {
        ...(emails ? { sha256_email_address: emails } : {}),
        ...(phones ? { sha256_phone_number: phones } : {})
    };
}

function prepare(
    field: string,
    value: string | string[] | undefined,
    normalize: (raw: string) => string | null
): string[] {
    const unique: string[] = [];
    for (const item of ([] as string[]).concat(value ?? [])) {
        // Untyped callers can pass anything; skip rather than throw.
        const normalized = typeof item === 'string' ? normalize(item) : null;
        if (normalized && !unique.includes(normalized)) {
            unique.push(normalized);
        }
    }
    if (unique.length > MAX_USER_DATA_VALUES) {
        console.warn(`[ng-ga4] user_data accepts at most ${MAX_USER_DATA_VALUES} ${field} values; sending the first ${MAX_USER_DATA_VALUES}.`);
    }
    return unique.slice(0, MAX_USER_DATA_VALUES);
}

// The gtag.js `_ga` cookie, read and written as gtag writes it.
//
// gtag stores its client ID in `_ga` as `GA1.<domainComponents>.<clientId>`, on the
// registrable domain, with a two-year expiry. This library stored its own UUID in
// origin-scoped localStorage instead, so a site running both counted one human as
// two users and our `www.` and `app.` subdomains diverged where gtag's would not.
//
// Everything here is pure string work with no global access — the same shape as
// `countryFromTimeZone(tz)` and `deviceFromUserAgent(ua, maxTouchPoints)` — so the
// sharp edges (and they are all in the parsing) are testable as a plain table.

/**
 * Read one cookie out of a `document.cookie` string.
 *
 * Matches on name boundaries rather than substring. The naive `/_ga=([^;]+)/`
 * is wrong twice over: it matches inside a cookie named `x_ga`, and gtag's own
 * `_ga_<STREAM>` session cookie sits in the same jar as `_ga`.
 *
 * Returns `null` when absent, or the decoded value — which may be `''` for a
 * present but valueless cookie, a case the caller must not confuse with absence.
 */
export function readCookieValue(jar: string, name: string): string | null {
    if (typeof jar !== 'string' || !jar) {
        return null;
    }
    for (const part of jar.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) {
            continue;
        }
        if (part.slice(0, separator).trim() !== name) {
            continue;
        }
        const raw = part.slice(separator + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            // A value that is not valid percent-encoding is still a value.
            return raw;
        }
    }
    return null;
}

/**
 * Extract the client ID from a `_ga` cookie value.
 *
 * Strips the `GA<n>.<n>.` prefix and returns the remainder, rather than assuming
 * the payload's shape: the second field is a domain-component count, not a version,
 * and this library writes a pre-existing UUID into `_ga` when asked to, so there is
 * not always a numeric pair to find. A bare `<digits>.<digits>` is accepted too.
 */
export function parseGaCookie(value: string): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const prefixed = /^GA\d+\.\d+\.(.+)$/.exec(trimmed);
    if (prefixed) {
        const clientId = prefixed[1].trim();
        return clientId || null;
    }
    // Defensive interop: server-side and custom `_ga` writers do not all emit gtag's prefix.
    // The strict `^\d+\.\d+$` test ensures this branch cannot swallow junk: anything that
    // is not exactly two numeric fields still returns null.
    return /^\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Mint a client ID in gtag's `<random>.<firstSeenSeconds>` shape.
 *
 * Expects `random` to be an integer in `[1, 2^31 - 1]` — a range the caller
 * enforces when drawing from `crypto.getRandomValues`. That range is what gives
 * gtag's IDs their familiar ten-digit first field.
 */
export function mintGtagClientId(nowMs: number, random: number): string {
    return `${random}.${Math.floor(nowMs / 1000)}`;
}

/**
 * Build a `_ga` cookie value. `domainComponents` is the number of dot-separated
 * labels in the cookie's domain (`example.com` → 2), which is what gtag puts in
 * the second field.
 */
export function formatGaCookie(clientId: string, domainComponents: number): string {
    return `GA1.${domainComponents}.${clientId}`;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Candidate cookie domains for `hostname`, shortest first.
 *
 * `www.example.co.uk` yields `co.uk`, `example.co.uk`, `www.example.co.uk`. The
 * caller trial-sets a cookie at each in turn and keeps the first that sticks:
 * browsers refuse cookies on public suffixes, so `co.uk` fails and
 * `example.co.uk` succeeds. That refusal is the only public-suffix oracle
 * available on the client.
 *
 * Empty for hosts where a domain-scoped cookie is meaningless: a single label
 * (`localhost`) needs no domain attribute, and an IP literal cannot carry one.
 */
export function registrableDomainCandidates(hostname: string): string[] {
    if (typeof hostname !== 'string' || !hostname) {
        return [];
    }
    if (hostname.includes(':') || IPV4.test(hostname)) {
        return [];
    }
    const labels = hostname.split('.');
    const candidates: string[] = [];
    let startI = labels.length - 2;

    // For 4-label hostnames with short initial labels (e.g., a.b.example.com),
    // skip the 2-label suffix to avoid trial-setting at overly broad scope.
    if (labels.length === 4 && labels[0].length <= 2 && labels[1].length <= 2) {
        startI = labels.length - 3;
    }

    for (let i = startI; i >= 0; i--) {
        candidates.push(labels.slice(i).join('.'));
    }
    return candidates;
}

import { parseGaCookie, readCookieValue } from './ga-cookie';

describe('readCookieValue', () => {
    it('reads a cookie by exact name', () => {
        expect(readCookieValue('_ga=GA1.1.111.222', '_ga')).toBe('GA1.1.111.222');
    });

    it('reads a cookie from the middle of a jar', () => {
        const jar = '_gid=GA1.1.9.9; _ga=GA1.1.111.222; _gat=1';
        expect(readCookieValue(jar, '_ga')).toBe('GA1.1.111.222');
    });

    // Browsers put a space after each ';' when serialising document.cookie.
    it('tolerates the leading space browsers add after a semicolon', () => {
        expect(readCookieValue('other=1;   _ga=GA1.1.111.222', '_ga')).toBe('GA1.1.111.222');
    });

    // The naive /_ga=([^;]+)/ matches inside this name. It must not.
    it('does not match a cookie whose name merely ends with the target', () => {
        expect(readCookieValue('x_ga=nope', '_ga')).toBeNull();
    });

    // gtag's own session cookie sits in the same jar as _ga.
    it('does not match gtag\'s _ga_<STREAM> session cookie', () => {
        expect(readCookieValue('_ga_ABC123=GS1.1.1700000000.1.0.1700000000.0.0.0', '_ga')).toBeNull();
    });

    it('prefers the exactly-named cookie over lookalikes', () => {
        const jar = '_ga_ABC123=GS1.1.7; x_ga=nope; _ga=GA1.1.111.222';
        expect(readCookieValue(jar, '_ga')).toBe('GA1.1.111.222');
    });

    it('decodes a URL-encoded value', () => {
        expect(readCookieValue('_ga=GA1.1.111.222%20', '_ga')).toBe('GA1.1.111.222 ');
    });

    it('falls back to raw value when percent-encoding is invalid', () => {
        expect(readCookieValue('_ga=abc%zzdef', '_ga')).toBe('abc%zzdef');
    });

    it('returns null for an absent cookie, an empty jar, and a non-string jar', () => {
        expect(readCookieValue('other=1', '_ga')).toBeNull();
        expect(readCookieValue('', '_ga')).toBeNull();
        expect(readCookieValue(undefined as any, '_ga')).toBeNull();
    });

    it('returns an empty string for a present but valueless cookie', () => {
        expect(readCookieValue('_ga=', '_ga')).toBe('');
    });
});

describe('parseGaCookie', () => {
    // The second field is a domain-component count, not a version, so both of
    // these are ordinary values seen in the wild.
    it('parses the GA1.1 form', () => {
        expect(parseGaCookie('GA1.1.1234567890.1678901234')).toBe('1234567890.1678901234');
    });

    it('parses the GA1.2 form', () => {
        expect(parseGaCookie('GA1.2.1234567890.1678901234')).toBe('1234567890.1678901234');
    });

    it('parses a prefix it has not seen before rather than hard-coding GA1', () => {
        expect(parseGaCookie('GA2.3.1234567890.1678901234')).toBe('1234567890.1678901234');
    });

    // This library writes an existing UUID into _ga when asked to, so the parser
    // must round-trip a payload that is not gtag's numeric pair.
    it('parses a non-numeric payload written by this library', () => {
        expect(parseGaCookie('GA1.1.12345678-1234-1234-1234-123456789abc'))
            .toBe('12345678-1234-1234-1234-123456789abc');
    });

    it('accepts a bare numeric pair with no prefix', () => {
        expect(parseGaCookie('1234567890.1678901234')).toBe('1234567890.1678901234');
    });

    it('trims surrounding whitespace', () => {
        expect(parseGaCookie('  GA1.1.111.222  ')).toBe('111.222');
    });

    it('rejects junk, empties and non-strings', () => {
        expect(parseGaCookie('garbage')).toBeNull();
        expect(parseGaCookie('GA1.1.')).toBeNull();
        expect(parseGaCookie('')).toBeNull();
        expect(parseGaCookie('   ')).toBeNull();
        expect(parseGaCookie(null as any)).toBeNull();
    });

    it('rejects a prefixed value whose remainder is whitespace-only', () => {
        expect(parseGaCookie('GA1.1.   ')).toBeNull();
    });
});

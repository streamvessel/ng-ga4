import { countryFromTimeZone } from './tz-country';

describe('countryFromTimeZone', () => {
    it('maps common canonical zones to ISO 3166-1 alpha-2 codes', () => {
        expect(countryFromTimeZone('America/New_York')).toBe('US');
        expect(countryFromTimeZone('America/Los_Angeles')).toBe('US');
        expect(countryFromTimeZone('Europe/London')).toBe('GB');
        expect(countryFromTimeZone('Europe/Berlin')).toBe('DE');
        expect(countryFromTimeZone('Asia/Kolkata')).toBe('IN');
        expect(countryFromTimeZone('Asia/Tokyo')).toBe('JP');
        expect(countryFromTimeZone('Australia/Sydney')).toBe('AU');
        expect(countryFromTimeZone('America/Sao_Paulo')).toBe('BR');
    });

    it('maps multi-segment zones (e.g. Argentina, Indiana)', () => {
        expect(countryFromTimeZone('America/Argentina/Buenos_Aires')).toBe('AR');
        expect(countryFromTimeZone('America/Indiana/Indianapolis')).toBe('US');
    });

    it('maps legacy aliases that some browsers still emit', () => {
        expect(countryFromTimeZone('Asia/Calcutta')).toBe('IN');
        expect(countryFromTimeZone('Europe/Kiev')).toBe('UA');
        expect(countryFromTimeZone('US/Pacific')).toBe('US');
        expect(countryFromTimeZone('Asia/Ulan_Bator')).toBe('MN');
        expect(countryFromTimeZone('Asia/Macao')).toBe('MO');
        expect(countryFromTimeZone('Pacific/Samoa')).toBe('WS');
        expect(countryFromTimeZone('Pacific/Ponape')).toBe('FM');
    });

    it('returns undefined for country-less or unknown zones', () => {
        expect(countryFromTimeZone('UTC')).toBeUndefined();
        expect(countryFromTimeZone('Etc/GMT')).toBeUndefined();
        expect(countryFromTimeZone('Not/AZone')).toBeUndefined();
    });

    it('returns undefined for empty, null or undefined input', () => {
        expect(countryFromTimeZone('')).toBeUndefined();
        expect(countryFromTimeZone(null)).toBeUndefined();
        expect(countryFromTimeZone(undefined)).toBeUndefined();
    });
});

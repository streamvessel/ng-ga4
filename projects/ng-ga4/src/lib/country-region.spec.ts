import { regionFromCountry } from './country-region';
import { countryFromTimeZone } from './tz-country';

describe('regionFromCountry', () => {
    it('maps countries to UN M49 continent and subcontinent codes', () => {
        expect(regionFromCountry('US')).toEqual({ continent_id: '019', subcontinent_id: '021' });
        expect(regionFromCountry('DE')).toEqual({ continent_id: '150', subcontinent_id: '155' });
        expect(regionFromCountry('GB')).toEqual({ continent_id: '150', subcontinent_id: '154' });
        expect(regionFromCountry('IT')).toEqual({ continent_id: '150', subcontinent_id: '039' });
        expect(regionFromCountry('UA')).toEqual({ continent_id: '150', subcontinent_id: '151' });
        expect(regionFromCountry('IN')).toEqual({ continent_id: '142', subcontinent_id: '034' });
        expect(regionFromCountry('JP')).toEqual({ continent_id: '142', subcontinent_id: '030' });
        expect(regionFromCountry('AU')).toEqual({ continent_id: '009', subcontinent_id: '053' });
        expect(regionFromCountry('EG')).toEqual({ continent_id: '002', subcontinent_id: '015' });
    });

    it('uses intermediate regions inside Sub-Saharan Africa and Latin America', () => {
        expect(regionFromCountry('NG')).toEqual({ continent_id: '002', subcontinent_id: '011' });
        expect(regionFromCountry('KE')).toEqual({ continent_id: '002', subcontinent_id: '014' });
        expect(regionFromCountry('CD')).toEqual({ continent_id: '002', subcontinent_id: '017' });
        expect(regionFromCountry('ZA')).toEqual({ continent_id: '002', subcontinent_id: '018' });
        expect(regionFromCountry('BR')).toEqual({ continent_id: '019', subcontinent_id: '005' });
        expect(regionFromCountry('MX')).toEqual({ continent_id: '019', subcontinent_id: '013' });
        expect(regionFromCountry('JM')).toEqual({ continent_id: '019', subcontinent_id: '029' });
    });

    it('keeps the Channel Islands in Northern Europe and places Taiwan in Eastern Asia', () => {
        expect(regionFromCountry('JE')).toEqual({ continent_id: '150', subcontinent_id: '154' });
        expect(regionFromCountry('GG')).toEqual({ continent_id: '150', subcontinent_id: '154' });
        expect(regionFromCountry('TW')).toEqual({ continent_id: '142', subcontinent_id: '030' });
    });

    it('covers every country the time zone lookup can produce, except Antarctica', () => {
        const zones: string[] = (Intl as any).supportedValuesOf?.('timeZone') ?? [];
        expect(zones.length).toBeGreaterThan(0);
        const missing = zones
            .map(zone => countryFromTimeZone(zone))
            .filter((country): country is string => !!country && country !== 'AQ')
            .filter(country => !regionFromCountry(country));
        expect(missing).toEqual([]);
    });

    it('returns three-digit zero-padded codes', () => {
        const region = regionFromCountry('NZ');
        expect(region?.continent_id).toMatch(/^\d{3}$/);
        expect(region?.subcontinent_id).toMatch(/^\d{3}$/);
    });

    it('returns undefined for Antarctica, unknown codes and inherited keys', () => {
        expect(regionFromCountry('AQ')).toBeUndefined();
        expect(regionFromCountry('ZZ')).toBeUndefined();
        expect(regionFromCountry('us')).toBeUndefined();
        expect(regionFromCountry('constructor')).toBeUndefined();
    });

    it('returns undefined for empty, null or undefined input', () => {
        expect(regionFromCountry('')).toBeUndefined();
        expect(regionFromCountry(null)).toBeUndefined();
        expect(regionFromCountry(undefined)).toBeUndefined();
    });

    it('returns a fresh object each call', () => {
        const first = regionFromCountry('FR')!;
        first.continent_id = 'tampered';
        expect(regionFromCountry('FR')).toEqual({ continent_id: '150', subcontinent_id: '155' });
    });
});

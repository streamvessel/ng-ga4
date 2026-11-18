import {
    hashUserData,
    normalizeCountry,
    normalizeEmail,
    normalizeNameOrPlace,
    normalizePhone,
    normalizePostalCode,
    normalizeStreet,
    sha256Hex
} from './user-data';

// Expected digests computed independently with `printf '%s' <value> | sha256sum`.
const JOHNSMITH_GMAIL = '3586de92bb3636d0885a12eff961429a32e4ebd764b96f50d85d016f9338d586'; // johnsmith@gmail.com
const JANE_DOE_EXAMPLE = '86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d'; // jane.doe@example.com
const PHONE_US = '910a625c4ba147b544e6bd2f267e130ae14c591b6ba9c25cb8573322dedbebd0'; // +15555555555
const JANE = '81f8f6dde88365f3928796ec7aa53f72820b06db8664f5fe76a7eb13e24546a2';
const DOE = '799ef92a11af918e3fb741df42934f3b568ed2d93ac1df74f1b8d41a27932a6f';
const STREET = '22b7e2d69b91e0ef4a88e81a73d897b92fd9c93ccfbe0a860f77db16c26f662e'; // 1600 amphitheatre pkwy
const MULLER = '2dbd218072117713f2d5996a726a9b216ed791ffd0783b6ba4ab6d61b8333192'; // müller

describe('user-data', () => {
    const subtle = crypto.subtle;

    describe('normalizeEmail()', () => {
        it('lowercases and removes all whitespace', () => {
            expect(normalizeEmail('  Jane.Doe @Example.COM \n')).toBe('jane.doe@example.com');
        });

        it('drops periods before the @ for gmail.com and googlemail.com only', () => {
            expect(normalizeEmail('John.Smith@Gmail.com')).toBe('johnsmith@gmail.com');
            expect(normalizeEmail('j.o.h.n@googlemail.com')).toBe('john@googlemail.com');
            expect(normalizeEmail('john.smith@example.com')).toBe('john.smith@example.com');
            expect(normalizeEmail('john.smith@notgmail.com')).toBe('john.smith@notgmail.com');
        });

        it('returns null for a blank value or anything that is not an address', () => {
            expect(normalizeEmail('   ')).toBeNull();
            expect(normalizeEmail('N/A')).toBeNull();
            expect(normalizeEmail('@example.com')).toBeNull();
            expect(normalizeEmail('jane@')).toBeNull();
        });
    });

    describe('normalizePhone()', () => {
        it('strips non-digits and adds a + prefix', () => {
            expect(normalizePhone('+1 (555) 555-5555')).toBe('+15555555555');
            expect(normalizePhone('1.555.555.5555')).toBe('+15555555555');
        });

        it('drops a leading 00 international prefix', () => {
            expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
        });

        it('returns null when no digits remain', () => {
            expect(normalizePhone(' - ')).toBeNull();
        });
    });

    it('sha256Hex() produces lowercase hex of the UTF-8 bytes', async () => {
        expect(await sha256Hex('+15555555555', subtle)).toBe(PHONE_US);
    });

    describe('hashUserData()', () => {
        it('normalises before hashing and sends only digests', async () => {
            const payload = await hashUserData({ email: ' John.Smith@GMAIL.com', phone: '+1 555-555-5555' }, subtle);
            expect(payload).toEqual({
                sha256_email_address: [JOHNSMITH_GMAIL],
                sha256_phone_number: [PHONE_US]
            });
        });

        it('accepts arrays, collapsing duplicates after normalisation', async () => {
            const payload = await hashUserData({ email: ['jane.doe@example.com', 'JANE.DOE@example.com', 'johnsmith@gmail.com'] }, subtle);
            expect(payload).toEqual({ sha256_email_address: [JANE_DOE_EXAMPLE, JOHNSMITH_GMAIL] });
        });

        it('caps each list at 3 values with a warning', async () => {
            spyOn(console, 'warn');
            const payload = await hashUserData({ phone: ['+11', '+12', '+13', '+14'] }, subtle);
            expect(payload!.sha256_phone_number!.length).toBe(3);
            expect(console.warn).toHaveBeenCalled();
        });

        it('returns null when nothing usable is left', async () => {
            expect(await hashUserData({}, subtle)).toBeNull();
            expect(await hashUserData({ email: ' ', phone: '' }, subtle)).toBeNull();
        });
    });

    describe('address normalisation', () => {
        it('names, city and region lose digits and symbols, keep letters of any script', () => {
            expect(normalizeNameOrPlace('  Jane-3! ')).toBe('jane');
            expect(normalizeNameOrPlace('MÜLLER')).toBe('müller');
            expect(normalizeNameOrPlace('São Paulo')).toBe('são paulo');
            expect(normalizeNameOrPlace('123')).toBeNull();
        });

        it('street loses symbols but keeps digits', () => {
            expect(normalizeStreet(' 1600 Amphitheatre Pkwy. ')).toBe('1600 amphitheatre pkwy');
        });

        it('postal code loses only . and ~', () => {
            expect(normalizePostalCode(' 94043~1351. ')).toBe('940431351');
            expect(normalizePostalCode('SW1A 1AA')).toBe('SW1A 1AA');
        });

        it('country must be an ISO 3166-1 alpha-2 code', () => {
            expect(normalizeCountry(' us ')).toBe('US');
            expect(normalizeCountry('USA')).toBeNull();
        });
    });

    describe('pre-hashed values', () => {
        it('sends a supplied digest as-is (lowercased) and merges it with hashed raw values', async () => {
            const payload = await hashUserData({
                email: 'jane.doe@example.com',
                sha256EmailAddress: [JOHNSMITH_GMAIL.toUpperCase(), JANE_DOE_EXAMPLE]
            }, subtle);
            expect(payload).toEqual({ sha256_email_address: [JANE_DOE_EXAMPLE, JOHNSMITH_GMAIL] });
        });

        it('drops anything that is not a digest, without logging the value', async () => {
            const warn = spyOn(console, 'warn');
            const payload = await hashUserData({ sha256PhoneNumber: '+15555555555', sha256EmailAddress: 'jane@example.com' }, subtle);
            expect(payload).toBeNull();
            expect(warn).toHaveBeenCalledTimes(2);
            const logged = JSON.stringify(warn.calls.allArgs());
            expect(logged).not.toContain('5555');
            expect(logged).not.toContain('jane');
        });

        it('caps raw and pre-hashed values together at 3', async () => {
            spyOn(console, 'warn');
            const payload = await hashUserData({ phone: ['+11', '+12'], sha256PhoneNumber: [JANE, DOE] }, subtle);
            expect(payload!.sha256_phone_number!.length).toBe(3);
        });
    });

    describe('address', () => {
        it('hashes name and street, sends city, region, postal code and country normalised', async () => {
            const payload = await hashUserData({
                address: {
                    firstName: ' Jane ', lastName: 'Doe', street: '1600 Amphitheatre Pkwy.',
                    city: 'Mountain View', region: 'CA', postalCode: '94043', country: 'us'
                }
            }, subtle);
            expect(payload).toEqual({
                address: [{
                    sha256_first_name: JANE,
                    sha256_last_name: DOE,
                    sha256_street: STREET,
                    city: 'mountain view',
                    region: 'ca',
                    postal_code: '94043',
                    country: 'US'
                }]
            });
            expect(JSON.stringify(payload)).not.toContain('Jane');
            expect(JSON.stringify(payload)).not.toContain('Amphitheatre');
        });

        it('hashes non-ASCII names as UTF-8', async () => {
            const payload = await hashUserData({ address: { lastName: 'Müller' } }, subtle);
            expect(payload).toEqual({ address: [{ sha256_last_name: MULLER }] });
        });

        it('prefers a supplied digest over a raw value for the same field', async () => {
            const payload = await hashUserData({ address: { firstName: 'Someone', sha256FirstName: JANE } }, subtle);
            expect(payload!.address![0].sha256_first_name).toBe(JANE);
        });

        it('skips empty addresses and caps the rest at 2', async () => {
            spyOn(console, 'warn');
            const payload = await hashUserData({
                address: [{ city: '42' }, { country: 'US' }, { country: 'DE' }, { country: 'FR' }]
            }, subtle);
            expect(payload!.address).toEqual([{ country: 'US' }, { country: 'DE' }]);
            expect(console.warn).toHaveBeenCalled();
        });
    });
});

import { hashUserData, normalizeEmail, normalizePhone, sha256Hex } from './user-data';

// Expected digests computed independently with `printf '%s' <value> | sha256sum`.
const JOHNSMITH_GMAIL = '3586de92bb3636d0885a12eff961429a32e4ebd764b96f50d85d016f9338d586'; // johnsmith@gmail.com
const JANE_DOE_EXAMPLE = '86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d'; // jane.doe@example.com
const PHONE_US = '910a625c4ba147b544e6bd2f267e130ae14c591b6ba9c25cb8573322dedbebd0'; // +15555555555

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

        it('returns null for a blank value', () => {
            expect(normalizeEmail('   ')).toBeNull();
        });
    });

    describe('normalizePhone()', () => {
        it('strips non-digits and adds a + prefix', () => {
            expect(normalizePhone('+1 (555) 555-5555')).toBe('+15555555555');
            expect(normalizePhone('1.555.555.5555')).toBe('+15555555555');
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
});

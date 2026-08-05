import { seedNgGa4ClientId } from './seed-client-id';

describe('seedNgGa4ClientId', () => {
    let originalChromeStorage: any;

    beforeEach(() => {
        (window as any).chrome = (window as any).chrome || {};
        originalChromeStorage = (window as any).chrome.storage;
    });

    afterEach(() => {
        if (originalChromeStorage !== undefined) {
            (window as any).chrome.storage = originalChromeStorage;
        } else {
            delete (window as any).chrome.storage;
        }
    });

    function mockChrome(store: Record<string, any>, overrides: any = {}): void {
        (window as any).chrome.storage = {
            local: {
                get: (keys: string[]) => Promise.resolve(
                    keys.reduce((acc: any, k: string) => { if (store[k] !== undefined) acc[k] = store[k]; return acc; }, {})
                ),
                set: (items: any) => { Object.assign(store, items); return Promise.resolve(); },
                ...overrides
            }
        };
    }

    it('mints and persists a client ID when none is stored', async () => {
        const store: Record<string, any> = {};
        mockChrome(store);

        const result = await seedNgGa4ClientId();

        expect(typeof result).toBe('string');
        expect(result!.length).toBeGreaterThan(0);
        expect(store['ga_client_id']).toBe(result!);
    });

    it('returns the stored client ID without overwriting it', async () => {
        const store: Record<string, any> = { ga_client_id: 'already-here' };
        const setSpy = jasmine.createSpy('set').and.returnValue(Promise.resolve());
        mockChrome(store, { set: setSpy });

        const result = await seedNgGa4ClientId();

        expect(result).toBe('already-here');
        expect(setSpy).not.toHaveBeenCalled();
    });

    it('ignores a non-string stored value and mints instead', async () => {
        const store: Record<string, any> = { ga_client_id: 42 };
        mockChrome(store);

        const result = await seedNgGa4ClientId();

        expect(typeof result).toBe('string');
        expect(store['ga_client_id']).toBe(result!);
    });

    it('returns null and warns when chrome.storage is unavailable', async () => {
        delete (window as any).chrome.storage;
        spyOn(console, 'warn');

        expect(await seedNgGa4ClientId()).toBeNull();
        expect(console.warn).toHaveBeenCalled();
    });

    it('returns null and warns when the read rejects', async () => {
        mockChrome({}, { get: () => Promise.reject(new Error('no access')) });
        spyOn(console, 'warn');

        expect(await seedNgGa4ClientId()).toBeNull();
        expect(console.warn).toHaveBeenCalled();
    });

    it('returns null and warns when the write rejects', async () => {
        mockChrome({}, { set: () => Promise.reject(new Error('quota exceeded')) });
        spyOn(console, 'warn');

        expect(await seedNgGa4ClientId()).toBeNull();
        expect(console.warn).toHaveBeenCalled();
    });
});

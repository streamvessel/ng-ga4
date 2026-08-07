/**
 * Write a client ID into `chrome.storage.local` if one is not there already.
 *
 * Call this from `chrome.runtime.onInstalled`, at service-worker top level:
 *
 * ```typescript
 * import { seedNgGa4ClientId } from '@stream-vessel/ng-ga4';
 *
 * chrome.runtime.onInstalled.addListener(() => seedNgGa4ClientId());
 * ```
 *
 * Call it for every `onInstalled` reason, not only `'install'`. Adding this to
 * an already-published extension gives every existing user `reason: 'update'`,
 * so a `reason` guard would skip exactly the population it protects.
 *
 * This is the only deterministic fix for the duplicate-client-ID problem in
 * issue #32. Without a seed, the first context to run has to mint an ID and
 * persist it — and an MV3 service worker can be terminated between those two
 * steps, so the next wake mints a *second* ID and the user is counted twice.
 * Two contexts starting cold at the same moment (worker plus popup) can also
 * both miss and both mint. Neither is preventable from inside the service:
 * awaiting the write makes our code wait, not Chrome. Seeding at install time
 * removes the mint path entirely, so there is nothing left to lose or race.
 *
 * Deliberately standalone — no Angular imports — so it can be called at worker
 * top level, before any injector exists.
 *
 * @returns The client ID now stored, or `null` if `chrome.storage` was
 * unavailable or the read or write failed. Never throws: a rejection escaping
 * an `onInstalled` listener would surface as an unhandled rejection during
 * worker startup.
 */
export async function seedNgGa4ClientId(): Promise<string | null> {
    try {
        // `chrome` is an undeclared identifier on Firefox, Safari and the server.
        // The typeof test is what makes that safe — it is specified not to throw
        // on a missing binding, and `||` short-circuits before the right-hand side
        // is evaluated. Optional chaining would NOT be enough on its own:
        // `chrome?.storage` short-circuits on a null *value*, not on a missing
        // *binding*, so simplifying this to just `!chrome?.storage?.local` would
        // throw a ReferenceError there.
        //
        // Kept inside the try so that simplification would be caught rather than
        // escaping into an onInstalled listener — the one thing this function
        // promises never to do. Belt and braces, not a fix for a live bug.
        if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
            console.warn('[ng-ga4] seedNgGa4ClientId: chrome.storage.local is unavailable.');
            return null;
        }
        const result = await chrome.storage.local.get(['ga_client_id']);
        const existing = result['ga_client_id'];
        // Idempotent by contract: onInstalled fires on update as well as install,
        // and overwriting here would re-identify every existing user on upgrade.
        if (typeof existing === 'string' && existing) {
            return existing;
        }
        // Matches what the service's own extension path mints, so a seeded ID and
        // a service-minted one are interchangeable. Not mintGtagClientId(): there
        // is no _ga cookie on a chrome-extension:// origin to align the shape with.
        const clientId = crypto.randomUUID();
        await chrome.storage.local.set({ ga_client_id: clientId });
        return clientId;
    } catch (err) {
        console.warn('[ng-ga4] seedNgGa4ClientId failed', err);
        return null;
    }
}

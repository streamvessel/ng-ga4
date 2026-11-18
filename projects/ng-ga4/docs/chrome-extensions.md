# Chrome extensions

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

1. Add the `storage` permission to `manifest.json`: `"permissions": ["storage"]`. The default extension CSP is fine, since no remote script is loaded.
2. Set `isExtension: true` and a `siteUrl`:

```typescript
NgGa4Module.forRoot({
    measurementId: 'G-XXXXXXXXX',
    apiSecret: 'your-api-secret',
    enabled: true,
    isExtension: true,
    siteUrl: 'https://your-extension-domain.com',
});
```

| Data | Web | Extension |
|---|---|---|
| Client ID | `_ga` if present (default), else `localStorage` | `chrome.storage.local` |
| Session number | `localStorage` | `chrome.storage.local` |
| Session ID and last activity | `localStorage` | `chrome.storage.session` |
| User properties | `localStorage` | `chrome.storage.local` |

## Service-worker teardown

Chrome stops an MV3 service worker once it goes idle, and a `chrome.storage` write still pending at that moment is lost. If the lost write was a new client ID, the next start creates another one and the user is counted twice.

**Create the client ID at install time.** Register this at the top level of the service worker, outside Angular:

```typescript
import { seedNgGa4ClientId } from '@stream-vessel/ng-ga4';

chrome.runtime.onInstalled.addListener(() => seedNgGa4ClientId());
```

Run it on every `onInstalled`, not only `reason === 'install'`: users of an already published extension only ever get `'update'`. The call is idempotent and never throws. It doesn't help a user who clears extension storage, since `onInstalled` doesn't fire again.

**Wait for pending writes before an event handler returns**, after tracking calls and after `setConsent()`:

```typescript
chrome.action.onClicked.addListener(async () => {
    ga.trackEvent('action_clicked');
    await ga.flushStorage();
});
```

`flushStorage()` covers storage, not event delivery ([#26](https://github.com/streamvessel/ng-ga4/issues/26)). Neither step survives a browser crash or an extension reload.

## Contexts starting together

The service worker and a popup or options page can start at the same moment with no client ID stored yet. Without coordination, both would create an ID and the user would be counted twice. The library prevents that with a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named `ng-ga4:client-id`: the second context waits for the first, then reads the ID the first one saved. `NgGa4Service` and `seedNgGa4ClientId()` take the same lock, in any combination of worker and pages. You don't need to do anything for this ([#51](https://github.com/streamvessel/ng-ga4/issues/51)).

What it doesn't cover:

- **Teardown.** The lock doesn't stop Chrome from stopping a worker between creating the ID and saving it. Keep calling `seedNgGa4ClientId()` from `onInstalled`, as described above.
- **Denied storage.** With `analyticsStorage` denied, nothing is saved, so there is no shared ID to read. Each context uses its own ID in memory, by design.
- **A stuck lock.** If the lock isn't granted within 3 seconds, or the browser has no Web Locks, the ID is created without it, as before. A context that times out this way can still end up with its own ID.

How we know: the specification says pages and workers of one origin share their locks, but doesn't mention extensions. We measured it in a scratch MV3 extension on Chromium 153 under Linux, with the library's own code racing in the worker and two extension pages; the tool and its results are in [`tools/lock-probe`](https://github.com/streamvessel/ng-ga4/tree/master/tools/lock-probe). It has not been run on branded Chrome, on other operating systems, or from a real install, where the contexts start cold rather than already running.

## Sessions across tabs

Every hit first reads the stored session and adopts a newer one, so tabs agree on the current session. On the web that read comes from `localStorage`. Extensions can't read `chrome.storage` synchronously, so they follow it through `chrome.storage.onChanged`.

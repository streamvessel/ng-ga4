# Chrome extensions

> Documented for the latest `master`, which can be ahead of the release on npm. Unreleased changes are listed under [Unreleased](../../../CHANGELOG.md#unreleased) in the changelog.

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

## Sessions across tabs

Every hit first reads the stored session and adopts a newer one, so tabs agree on the current session. On the web that read comes from `localStorage`. Extensions can't read `chrome.storage` synchronously, so they follow it through `chrome.storage.onChanged`.

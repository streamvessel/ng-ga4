# Consent

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

With no `consent` option and no `setConsent()` call, nothing changes: no `consent` field is sent, and GA4 applies your property's defaults.

For a consent banner, start disabled and enable when the user accepts:

```typescript
// In your providers: no client ID is created and nothing is stored yet.
provideNgGa4({ measurementId: 'G-XXXXXXXXX', apiSecret: 'your-api-secret', enabled: false, isExtension: false })

// In your consent banner component:
constructor(private ga4: NgGa4Service) {}

onBannerAccepted(): void {
    this.ga4.setConsent({ analyticsStorage: 'granted', adUserData: 'granted', adPersonalization: 'denied' });
    this.ga4.setEnabled(true);
}
```

Events fired while disabled are dropped, not queued, so the first page view before consent is lost. That is on purpose.

| Signal | Sent to GA4 | Effect |
|---|---|---|
| `adUserData` | as `consent.ad_user_data` | GA4 acts on it |
| `adPersonalization` | as `consent.ad_personalization` | GA4 acts on it |
| `analyticsStorage` | no | Whether this library stores identifiers |

Denying `analyticsStorage` stops every write to `localStorage`, `chrome.storage` and `_ga`, and deletes what is already stored (the user ID too), also on a start-up that begins denied. Collection continues with an ID held in memory, so each page load is a new user and session. Under [`'storage'`](identity.md#client-id-and-gtagjs) the cookie is left alone; where `gtag.js` also runs, it writes `_ga` again on its next hit.

Things to know:

- **This library doesn't store consent, and each tab or extension context has its own.** Call `setConsent()` on every start-up from your own record of the user's choice, in every context. A tab that is still granted keeps writing session data to the shared store after another tab denies.
- **`setEnabled(false)` stops sending but deletes nothing.** To remove stored identifiers, deny `analyticsStorage`.
- **Granting again restores the client ID, user ID and session at once, but `_ga` only on the next page load.**
- An invalid consent value counts as `denied`, with a warning.

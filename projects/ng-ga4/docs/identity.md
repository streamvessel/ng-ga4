# Identity: client ID, user ID, user properties and user-provided data

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

## Client ID and gtag.js

On the web the client ID comes from `clientIdSource`:

- **`'auto'`** (default): use the `_ga` cookie when it is present and well formed, else this library's own ID in `localStorage`. A site running both `gtag.js` and this library counts each person once, across subdomains too. The adopted ID is never copied into storage, so deleting `_ga` returns to the library's own ID.
- **`'cookie'`**: `_ga` is the only source. One is created if missing (this implies `writeGaCookie`), reusing an ID already stored in `gtag.js`'s format. An older UUID-style ID is replaced, so those users are counted as new once.
- **`'storage'`**: `localStorage` only. `_ga` is never read or written.

Reading an existing cookie is itself a consent-relevant act. Use `'storage'` if this library must never read `_ga`.

A `_ga` value is accepted only in `gtag.js`'s own format, with an ID of at most 64 characters (letters, digits, `.`, `_`, `-`). Anything else is ignored. This keeps out malformed and oversized values; it can't tell a well-formed cookie planted from another subdomain from a real one.

**`writeGaCookie`** writes `_ga` when there is none or it fails the check above, using the library's own ID, on the registrable domain, with `SameSite=Lax`, `Secure` on HTTPS and `gtag.js`'s two-year expiry. An ID adopted from a cookie is never written back. Pass `NgGa4CookieOptions` to change the defaults:

- `domain`: e.g. `'.example.com'`. Without it, the library finds the registrable domain by setting a short-lived probe cookie (`_ng_ga4_probe_<random>`) at each candidate and keeping the first the browser accepts. If the browser refuses every candidate, no `_ga` is written at all; a single-label host such as `localhost` gets a host-only cookie. Set `domain` to skip the probe, for instance if a consent platform needs a fixed list of cookie names.
- `flags`: replaces the default attributes, e.g. `'SameSite=None; Secure'` for a cross-site iframe.
- `maxAgeSeconds`: lifetime, two years by default.

**Upgrading** a site that also runs `gtag.js` moves each returning user onto the `gtag.js` identity, once. That is a one-off jump in user counts; plan when you ship it.

## User ID

Call `setUserId()` when a user signs in, and `setUserId(null)` when they sign out. Every hit after that carries a top-level `user_id`, the same as `gtag('config', 'G-XXXXXXXXX', { user_id })`, so GA4 can join one person across devices and platforms.

```typescript
onSignIn(user: User) {
    this.analytics.setUserId(user.id);
}

onSignOut() {
    this.analytics.setUserId(null);
}
```

- Use your own opaque ID, at most 256 characters. Never send an email address or other personal data. A longer value, or one that isn't a string, logs a warning and clears the user ID.
- The ID is stored next to the client ID (`localStorage`, or `chrome.storage.local` in an extension) and comes back on the next load, so you don't need to set it again on every start-up. An empty string counts as `null`.
- It is always the top-level field, never a user property: `user_id` is a reserved user property name.
- Calling it before collection starts is fine; it is stored once `init()` runs. With `analyticsStorage` denied, an ID you set is sent but not stored; a stored one is deleted, and not sent, also on a start-up that begins denied.
- Each tab or extension context keeps its own copy until its next load, so sign out in every context that is open.

## User properties

The equivalent of `gtag('set', 'user_properties', { ... })`:

```typescript
this.analytics.setUserProperties({ plan: 'pro', seats: 5 });
this.analytics.setUserProperties({ seats: null });  // remove one
this.analytics.setUserProperties(null);             // remove all
```

- Each call merges into what is already set. `null` removes a property; `undefined` leaves it as it is, so `{ plan: user?.plan }` before the user has loaded doesn't delete a stored plan. They go out as `user_properties` on every later hit, including page views and the hide-time engagement event.
- They are stored next to the client ID, so they survive a reload, and are deleted with it when `analyticsStorage` is denied (see [Consent](consent.md)). Each call merges onto what other tabs or extension contexts have stored, so one never wipes another's properties; a tab still sends its own copy on hits until its next call or reload.
- Calls made before `init()` has finished, including while collection is off before it first runs, are applied once it does. After that, calls are stored at once even while collection is off, as `setUserId()` does. On the server the call does nothing.
- Anything GA4 would reject is dropped, with a console warning in dev mode: more than 25 properties (those already set win), a name longer than 24 characters or not made of letters, digits and underscores, a value longer than 36 characters (counted as characters, so an emoji is one), the reserved names `first_open_time`, `first_visit_time`, `last_deep_link_referrer`, `user_id` and `first_open_after_install`, and names starting with `_`, `ga_`, `google_` or `firebase_` in any letter case.
- To see a property in reports, register it in GA4 as a user-scoped custom dimension.

## User-provided data

Off unless you call `setUserData()`. The library never reads an email address or phone number on its own, and never detects one on the page the way `gtag.js`'s automatic collection can. Google uses the hashes for [enhanced conversions](https://developers.google.com/analytics/devguides/collection/ga4/uid-data) in Google Ads, and GA4 uses them for conversion modelling and other "enhanced Analytics capabilities".

Two things are needed before anything is sent and used:

- **In GA4:** link the property to Google Ads, then turn on **Admin → Data collection → User-provided data collection** and accept the policy. Without that, GA4 drops the data. It isn't available for properties in the Health industry category, and Google still calls the feature a beta. See [Google's setup guide](https://support.google.com/analytics/answer/14077171).
- **In your app:** grant `adUserData` consent, through the `consent` option or `setConsent({ adUserData: 'granted' })`. Until it is granted, `user_data` is held back. That includes when you never set consent at all.

```typescript
// After the user signs in, with data you already hold:
await this.analytics.setUserData({
    email: user.email,
    phone: user.phone, // E.164, e.g. '+15555555555'
    address: {
        firstName: user.firstName,
        lastName: user.lastName,
        street: user.street,
        city: user.city,
        region: user.region,
        postalCode: user.postalCode,
        country: user.country, // ISO 3166-1 alpha-2, e.g. 'US'
    },
});

// Or with values you have already normalised and hashed on your server:
await this.analytics.setUserData({ sha256EmailAddress: user.emailHash });

// On sign-out:
await this.analytics.setUserData(null);
```

Fields and how each is sent:

| Field | Sent as | Normalised before hashing |
|---|---|---|
| `email` | `sha256_email_address` | lowercased, spaces removed, dots before the `@` dropped for `gmail.com` and `googlemail.com`; values without an `@` and a domain are skipped |
| `phone` | `sha256_phone_number` | digits only, with `+` in front; a leading `00` is accepted in place of `+` |
| `address.firstName`, `address.lastName` | `sha256_first_name`, `sha256_last_name` | all spaces, digits and symbols removed, lowercased, as `gtag.js` does: `Mary Ann` becomes `maryann`, and `O'Brien` keeps its apostrophe |
| `address.street` | `sha256_street` | symbols removed, lowercased, trimmed |
| `address.city`, `address.region` | `city`, `region`, **not hashed** | digits and symbols removed, lowercased, trimmed, as `gtag.js` does |
| `address.postalCode` | `postal_code`, **not hashed** | `.` and `~` removed, trimmed |
| `address.country` | `country`, **not hashed** | `.` and `~` removed, trimmed; pass an ISO 3166-1 alpha-2 code such as `'US'` |

- Raw values are SHA-256 hashed in the browser, and only the hex digests of email, phone, name and street go into the request. City, region, postal code and country go as they are, because the Measurement Protocol expects them that way.
- Up to 3 emails, 3 phones and 2 addresses; more are cut with a warning. Empty values and duplicates are skipped.
- Include the country code in phone numbers. The library can't guess it, and a number without one never matches.
- For an address to be useful for matching, Google Ads asks for at least first name, last name, postal code and country.
- **Already hashed:** `sha256EmailAddress`, `sha256PhoneNumber`, and `sha256FirstName`, `sha256LastName` and `sha256Street` on an address take hex SHA-256 digests you computed yourself, after applying the same normalisation. As in `gtag.js`, a `sha256*` field replaces its raw counterpart, and any value that already is a 64-character hex digest (in either kind of field) is sent as-is. A value in a `sha256*` field that isn't a digest is normalised and hashed like a raw one, so a raw address passed there by mistake never goes out unhashed.
- Google recommends sending a [user ID](#user-id) alongside it.
- Nothing is stored, unlike the user ID. The hashes live in memory only, so call `setUserData()` again on every start-up and in every tab or extension context.
- Hits sent before the returned promise resolves go without `user_data`, including while replacing earlier data, so one user's hashes never go out on another user's hits.
- `user_data` goes out only while `adUserData` is `'granted'` (see [Consent](consent.md)). Data set before consent is granted is kept in memory and sent once it is. Denying consent again holds it back from the next hit on.
- With `debug: true`, the copy posted to the validation endpoint carries the same hashes.
- It needs `crypto.subtle`, which only exists in a secure context (HTTPS or `localhost`). Elsewhere the call does nothing and logs a warning; raw values are never sent. The returned promise never rejects.

**Your obligations.** A hashed email address is still personal data, and city, region and postal code go unhashed. Before you send it you must:

- have the user's consent to share it with Google for advertising (the `adUserData: 'granted'` the library requires should reflect a real choice, not a default);
- disclose it in your privacy policy;
- follow Google's [customer data policies](https://support.google.com/adspolicy/answer/7475709) and, in the EEA/UK, the [EU user consent policy](https://www.google.com/about/company/user-consent-policy/).

Clear it with `setUserData(null)` when the user signs out or withdraws consent.

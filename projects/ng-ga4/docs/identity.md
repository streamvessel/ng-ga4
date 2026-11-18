# Identity: client ID, user ID and user properties

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

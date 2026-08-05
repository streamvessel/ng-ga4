# Limitations versus gtag.js

This library sends events to GA4 over the **Measurement Protocol** (MP) instead
of loading `gtag.js` from `googletagmanager.com`. That is what lets it run under
a strict Content Security Policy and inside a Chrome MV3 extension — and it is
also why some GA4 reports will never populate, however much this library
implements.

Google states the boundary plainly:

> The intent of the Measurement Protocol is to augment automatic collection
> through gtag, Tag Manager, and Google Analytics for Firebase, not to replace
> it.

> While it's possible to send events to Google Analytics solely with the
> Measurement Protocol, only partial reporting may be available.

This page says which parts. Read it before adopting the library, not after
finding an empty report.

## How to read the "Basis" column

Claims here are not all the same kind, and the difference matters:

| Basis | Meaning |
|---|---|
| **Measured** | Observed directly on a scratch GA4 property fed only by MP. See [Evidence](#evidence). |
| **Derived** | Follows necessarily from something measured — GA4 computes the metric from a value we measured as absent. |
| **Inferred** | Consistent with what we measured, but not read directly. Treat as likely, not proven. |
| **Documented** | Google documents it. We did not test it ourselves. |

## Summary

### Does not work

| GA4 report or metric | On an MP-only property | Basis |
|---|---|---|
| Traffic acquisition — source / medium | Everything lands as `(direct) / (none)` | Measured |
| Session campaign | No rows at all | Measured |
| New users | `0`, even for never-before-seen client IDs | Measured |
| Engaged sessions | `0`, even above the 10-second threshold | Measured |
| Engagement rate, bounce rate | Both derive from engaged sessions | Derived |
| `session_start`, `first_visit` events | Never appear, and cannot be sent — reserved names | Measured |
| `user_engagement` event | Rejected outright: `NAME_RESERVED` | Measured |
| Sessions | Not trustworthy — GA4 derives it from `session_start` | Inferred |
| City, region | No server-side geolocation on `/mp/collect` | Documented |
| Demographics, interests, Google Signals | Require tagging | Documented |
| Ads remarketing, `gclid` linkage, conversion import | Require tagging | Documented |
| Cross-domain measurement (the `_gl` linker) | Not exposed by MP | Documented |
| Deleting `_ga` on consent withdrawal | Durable only if `gtag.js` is not co-installed — gtag rewrites the cookie on its next hit | Documented |

### Does work

| GA4 report or metric | Notes | Basis |
|---|---|---|
| Events and event parameters | The core of the library | Measured |
| Page views | Automatic via the Angular Router | Measured |
| Active users | Counted correctly from `client_id` | Measured |
| Average engagement time | Real measured foreground time, not a constant | Measured |
| Country | Approximated from the browser timezone, not from IP | By design |
| Realtime, DebugView | Both populate normally | Measured |

## The three that surprised us

The "Documented" rows above were known when this library was written. These
three were not — each was assumed to be a solvable backlog item, and each turned
out to be a property of the Measurement Protocol itself.

### Traffic attribution — everything is `(direct) / (none)`

Four separate mechanisms for supplying traffic source were tried on a property
with no tagging at all:

| Mechanism | Result |
|---|---|
| `utm_*` parameters inside `page_location` | No attribution derived |
| `source` / `medium` / `campaign` as event parameters | Accepted, then ignored |
| A `campaign_details` event | Validated clean, then **dropped entirely** — it exists nowhere in the property |
| `page_referrer` from an external origin | No referral attribution derived |
| `gclid` in `page_location` | No attribution derived |

Session campaign returned no rows under any of them. First user source/medium
settled on `(direct) / (none)`.

There is no configuration of this library that produces non-direct traffic in a
GA4 report. Tracked and closed won't-fix as
[#12](https://github.com/streamvessel/ng-ga4/issues/12).

### New users reads 0, and Sessions is unreliable

GA4 derives **New users** from the `first_visit` event and **Sessions** from
`session_start`. Both names are reserved on MP — this library cannot send them —
and GA4 does **not** synthesise them for MP-only traffic. Eight never-before-seen
client IDs produced `New users: 0`.

We measured New users directly. The effect on Sessions is inference from the same
mechanism: we did not read the Sessions metric itself, so treat that row as
likely rather than proven. Tracked and closed as
[#17](https://github.com/streamvessel/ng-ga4/issues/17).

### Engagement time is credited, but sessions never become engaged

This one splits in half, and the halves come apart:

- **Average engagement time works.** A custom event carrying
  `engagement_time_msec: 15000` produced a non-zero average engagement time.
- **Engaged sessions stayed at `0`** — despite 15 s clearly clearing GA4's
  documented 10-second threshold.

So GA4 folds `engagement_time_msec` into the *time* metric but does not use it to
classify a session as *engaged*. Because engagement rate and bounce rate are both
computed from that classification, neither is trustworthy either.

The likely mechanism is that engaged-session status comes from an internal
`seg=1` signal that `gtag.js` sets on its own collection endpoint and MP does not
expose. That explanation fits everything observed but is **unproven** — the
conclusion above rests on the measurement, not on the mechanism. Tracked and
closed as [#43](https://github.com/streamvessel/ng-ga4/issues/43).

## Evidence

Every "Measured" row comes from one run against a scratch GA4 property created
for the purpose:

- **Untagged.** No `gtag.js` snippet anywhere — this is what makes the result
  meaningful. A tagged property would let MP events inherit session attributes
  from a tagged session and prove nothing.
- **Nine arms**, each with its own `client_id`, so each is its own user and its
  own session and no arm can contaminate another.
- **Read three times** — 4 h, 17.5 h and 54.5 h after sending — against standard
  reports, not just Realtime.

### Why three readings

The first read is not trustworthy, and this cost us a published error worth
passing on.

Event data, user counts and the engagement metrics were all stable from 4 hours.
**Attribution dimensions were not.** First user source/medium read `(not set)` at
17.5 h and only settled to `(direct) / (none)` by 54.5 h. We initially treated
`(not set)` as a finding in its own right; it was an intermediate processing
state.

If you reproduce this, do not generalise from a single early read of an
attribution dimension. It yields an answer that looks conclusive and is not.

## Not yet built

Separate from the above — these are gaps in *this library*, not in the
Measurement Protocol, and they are open work rather than permanent limits:

| Gap | Issue |
|---|---|
| `user_id` | [#18](https://github.com/streamvessel/ng-ga4/issues/18) |
| `user_properties` | [#19](https://github.com/streamvessel/ng-ga4/issues/19) |
| Event and parameter name validation in dev | [#29](https://github.com/streamvessel/ng-ga4/issues/29) |
| Enhanced measurement: scroll, outbound clicks, downloads, site search, forms | [#28](https://github.com/streamvessel/ng-ga4/issues/28) |
| Event batching, offline outbox, `flush()` | [#24](https://github.com/streamvessel/ng-ga4/issues/24), [#25](https://github.com/streamvessel/ng-ga4/issues/25), [#26](https://github.com/streamvessel/ng-ga4/issues/26) |

The full list is tracked in
[#34](https://github.com/streamvessel/ng-ga4/issues/34).

## If these limitations rule the library out

They should, for some projects. If you need traffic attribution, New users,
engaged sessions, demographics or Ads integration, and your app can load a script
from `googletagmanager.com`, use `gtag.js` — it is the right tool and this
library cannot substitute for it.

This library is for the case where that script cannot load at all: a strict CSP
with no `googletagmanager.com` allowance, or a Chrome MV3 extension, where the
alternative is not `gtag.js` but no analytics whatsoever.

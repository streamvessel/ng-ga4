# Event validation

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

GA4's `/mp/collect` answers `204` even for an event it is about to discard, so a typo in an event name would otherwise lose that data without a trace. `trackEvent()` checks each event against the [Measurement Protocol's rules](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#reserved_names) before sending it:

- **Event name:** at most 40 characters; starts with a letter; only letters (any script, so `café` and `購入` are fine), digits and underscores; not reserved (`session_start`, `first_visit`, `user_engagement`, `error`, `notification_open` and the rest of Google's list, or a `_`, `firebase_`, `ga_`, `google_` or `gtag.` prefix). An event that breaks one of these is **not sent**.
- **Parameter name:** at most 40 characters, same characters, not `firebase_conversion` and none of the prefixes above. A parameter that breaks one of these is **removed**; the rest of the event is sent.
- **Warnings only, sent unchanged:** App-stream event names (`ad_impression`, `in_app_purchase`, `screen_view`); string values over 100 characters (1000 for `page_location`, 420 for `page_referrer`, 300 for `page_title`), since GA4 360 properties allow 500; and events with more than 25 parameters, counting the ones the library adds except `debug_mode`.

In development (`isDevMode()`) or with `debug: true`, each problem is logged with `console.warn`, naming the event and the rule. In a production build without `debug`, invalid events and parameters are still dropped, silently.

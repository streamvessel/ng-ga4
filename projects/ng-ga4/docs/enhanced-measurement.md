# Enhanced measurement

> Describes the latest `master`. See [Which version these docs describe](README.md#which-version-these-docs-describe).

`gtag.js` collects a handful of events on its own ("Enhanced Measurement"). This library can send the same events, with the same names and parameters, so GA4's built-in reports pick them up. Each one is off unless you turn it on, so upgrading changes nothing you send:

```typescript
provideNgGa4({
    ...config,
    enhancedMeasurement: {
        scroll: true,
        outboundClicks: true,
        fileDownloads: true,
        siteSearch: true,
        forms: true,
        video: true
    }
})
```

- `scroll`: `scroll` with `percent_scrolled: 90` the first time the user scrolls the window to 90% of the page height, once per page view. A page too short to scroll, or one that scrolls inside its own container instead of the window, sends none.
- `outboundClicks`: `click` with `link_url`, `link_domain`, `link_id`, `link_classes` and `outbound: true` for a click (or middle-click) on an `http(s)` link to another host. The page's own host and the host of `siteUrl` count as yours.
- `fileDownloads`: `file_download` with `file_extension`, `file_name` (the link's path), `link_url`, `link_text`, `link_id` and `link_classes` for a link whose path ends in one of the extensions Google lists: `pdf`, `xls(x)`, `doc(x)`, `txt`, `rtf`, `csv`, `exe`, `key`, `pps`, `ppt(x)`, `7z`, `pkg`, `rar`, `gz`, `zip`, `avi`, `mov`, `mp4`, `mp(e)g`, `wmv`, `mid(i)`, `mp3`, `wav`, `wma`. A download to another host sends `file_download` only, not a `click` as well.
- `siteSearch`: `view_search_results` with `search_term` after a page view whose path has a `q`, `s`, `search`, `query` or `keyword` query parameter (the first one present, in that order). The term comes from the path you reported, so a query you strip before calling `trackPageView` is never read.
- `forms`: `form_start` the first time the user types into or changes a field of a form, once per form per page view, and `form_submit` when it is submitted, with `form_id`, `form_name`, `form_destination` and, on submit, `form_submit_text` (the button's text). Focusing a field isn't enough to count as a start. `form_destination` is only sent when the form has an `action` attribute; without one it would be the current address, unfiltered.
- `video`: `video_start` when a native `<video>` starts playing, `video_progress` as playback passes 10%, 25%, 50% and 75%, and `video_complete` when it ends, with `video_provider: 'html5'`, `video_title` (the `title` or `aria-label` attribute), `video_url`, `video_current_time`, `video_duration`, `video_percent` and `visible` (whether the player was on screen). Pausing and resuming doesn't start it again; a replay after the end, a new source or the next page view does. A seek past several milestones sends only the furthest one. `video_url` drops the query and fragment, which often hold a signed token, and is empty for `blob:` sources such as hls.js players. A live stream sends `video_start` and `video_complete` but no progress. Every `<video>` counts, including a muted background loop, which would send a start and up to four progress events per page view. To leave one out, put `data-ng-ga4-ignore` on the video or on any element around it:

  ```html
  <video src="hero.mp4" autoplay muted loop playsinline data-ng-ga4-ignore></video>
  ```

All of these carry the same `page_location` as the hide-time engagement event (see [Engagement time](engagement.md#engagement-time)), go through `trackEvent`, and stop with `setEnabled(false)`. The listeners run outside Angular's zone, so they don't trigger change detection, and are removed when the service is destroyed. Nothing is registered on the server, or in an extension's service worker, which has no page. Forms and videos inside a shadow root aren't seen, because their `submit`, `input` and media events don't leave it. Embedded YouTube players aren't tracked: gtag.js does that through YouTube's player script, and this library loads no external scripts.

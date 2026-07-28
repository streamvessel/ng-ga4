import { InjectionToken } from '@angular/core';

export interface NgGa4Config {
    measurementId: string;
    apiSecret: string;
    enabled: boolean;
    isExtension: boolean;
    siteUrl?: string;
    debug?: boolean;
    appVersion?: string;
    /**
     * Network transport for production (non-debug) hits.
     * - 'beacon' (default): navigator.sendBeacon, falling back to fetch(keepalive) then XHR.
     *   Survives page/tab unload, so events fired right before the user leaves are not lost.
     * - 'xhr': Angular HttpClient (XHR). Goes through the app's HTTP interceptors (retry),
     *   but in-flight requests are aborted when the document unloads.
     * Debug mode always uses XHR so the validation response can be read.
     */
    transport?: 'beacon' | 'xhr';
    /**
     * Where the client ID comes from on web. Ignored when `isExtension` is true —
     * there is no `_ga` cookie on a `chrome-extension://` origin.
     *
     * - `'auto'` (default): the `_ga` cookie if present and well-formed, else
     *   `localStorage`. A site also running gtag.js shares one identity with it;
     *   a site that is not behaves exactly as before.
     * - `'cookie'`: `_ga` is authoritative, and one is minted in gtag's format if
     *   absent. Implies `writeGaCookie` — choosing this source is itself the
     *   opt-in to setting a cookie. Note that it deliberately ignores an existing
     *   stored ID, which re-identifies that user once.
     * - `'storage'`: `localStorage` only. The behaviour of every version before
     *   this one.
     */
    clientIdSource?: 'auto' | 'cookie' | 'storage';

    /**
     * Write `_ga` when it is absent, in gtag's format, on the registrable domain,
     * with gtag's two-year expiry. Off by default: this library does not set a
     * cookie unless asked, which matters because Consent Mode is not implemented
     * yet. Ignored for `'storage'` and for extensions; implied by `'cookie'`.
     */
    writeGaCookie?: boolean;
}

export const NG_GA4_CONFIG = new InjectionToken<NgGa4Config>('NG_GA4_CONFIG');

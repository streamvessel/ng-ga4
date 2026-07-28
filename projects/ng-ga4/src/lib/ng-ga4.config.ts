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
}

export const NG_GA4_CONFIG = new InjectionToken<NgGa4Config>('NG_GA4_CONFIG');

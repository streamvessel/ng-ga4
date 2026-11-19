// User-agent string parsing, used only where `navigator.userAgentData` is missing.
//
// GA4's /mp/collect does not infer anything from the User-Agent request header — that
// inference is something gtag.js gets for free server-side and we do not. So on Safari
// and Firefox, which do not implement User-Agent Client Hints at all, the request-level
// `device` object would otherwise carry no browser, OS or category, and GA4 reports
// `(not set)` for all of them.
//
// The vocabulary here deliberately matches what `userAgentData.getHighEntropyValues()`
// returns ("Windows", "macOS", "Chrome OS", "Edge", "Chrome"), so both paths feed the
// same dimension with the same spellings.

export interface UaDeviceInfo {
    category?: string;
    operating_system?: string;
    operating_system_version?: string;
    browser?: string;
    browser_version?: string;
    model?: string;
    brand?: string;
}

interface Detected {
    name: string;
    version?: string;
}

// Windows reports a kernel version; GA4 users expect the marketing name.
//
// "10.0" is deliberately absent. Windows 11 reports `Windows NT 10.0` exactly like
// Windows 10 — Microsoft never bumped the token — so the legacy UA cannot separate them.
// Chromium disambiguates via Client Hints `platformVersion`; here the honest answer is
// no version at all. An unrecognised token maps to undefined for the same reason: a raw
// kernel number means nothing in a GA4 report.
const WINDOWS_NT_VERSIONS: Record<string, string> = {
    '6.3': '8.1',
    '6.2': '8',
    '6.1': '7',
    '6.0': 'Vista',
    '5.1': 'XP'
};

// Safari froze the macOS token at 10_15_7 from Big Sur onward, and Firefox caps it at
// 10.15. On exactly the browsers this fallback exists for, these values mean "unknown",
// not "Catalina" — emitting them would report every modern Mac as 10.15.7. Genuinely
// older versions (10.14.6 and friends) are unambiguous and still reported.
const FROZEN_MACOS_VERSIONS = new Set(['10.15', '10.15.7']);

export function deviceFromUserAgent(ua: string, maxTouchPoints = 0): UaDeviceInfo {
    if (typeof ua !== 'string' || !ua) {
        return {};
    }

    let os = detectOs(ua);
    const browser = detectBrowser(ua);

    // Recognising neither means this is not a UA we understand. Returning {} keeps the
    // caller's "fill only what's missing" merge honest instead of asserting 'desktop'
    // for anything unfamiliar.
    if (!os && !browser) {
        return {};
    }

    // Derived while the OS still reads macOS, because that is what the touch-point rule
    // for desktop-mode iPads keys on.
    const category = detectCategory(ua, os?.name, maxTouchPoints);

    // If maxTouchPoints was trusted enough to call this a tablet, it has to correct the
    // OS too. Otherwise the payload claims a tablet running macOS — an OS that has never
    // shipped on one — and every desktop-mode iPad is filed under macOS. The real iPadOS
    // version is not recoverable from a spoofed Mac UA, so none is reported.
    const desktopModeIPad = os?.name === 'macOS' && category === 'tablet';
    if (desktopModeIPad) {
        os = { name: 'iOS' };
    }

    const info: UaDeviceInfo = {};
    if (os) {
        info.operating_system = os.name;
        if (os.version) {
            info.operating_system_version = os.version;
        }
    }
    if (browser) {
        info.browser = browser.name;
        if (browser.version) {
            info.browser_version = browser.version;
        }
    }
    info.category = category;
    return Object.assign(info, detectHardware(ua, os?.name, desktopModeIPad));
}

// Shared by the Client Hints and UA-string paths so both classify alike. On Android,
// Chrome drops `mobile` (and the UA's "Mobile" token) at a smallest screen width of
// 600dp or more, so Android without it is a tablet. `formFactors` cannot decide on its
// own: Chrome derives it from `mobile`, so tablets report ["Desktop"]. It only adds an
// explicit "Tablet" (ChromeOS "Request tablet site") and "XR" (Android XR headsets,
// which are also Android without `mobile`).
export function deviceCategory(mobile: boolean, platform: string | undefined, formFactors: readonly unknown[] = []): string {
    if (formFactors.includes('Tablet')) {
        return 'tablet';
    }
    if (mobile) {
        return 'mobile';
    }
    return platform === 'Android' && !formFactors.includes('XR') ? 'tablet' : 'desktop';
}

// "K": since Chrome 110 every Android UA says "Android 10; K" whatever the device; the
// real model is only in Client Hints.
const NON_MODEL_ANDROID_TOKENS = /^(?:K|wv|Mobile|Tablet|HarmonyOS|HMSCore.*|rv:.*)$/;
// Pre-KitKat locale ("en-us"). Lower-case only, so short model names survive.
const LOCALE_TOKEN = /^[a-z]{2}(?:[-_][a-zA-Z]{2,4})?$/;

// Brand only where the UA leaves no doubt: iPhone/iPad/iPod can only be Apple, while an
// Android prefix ("SM-", "Pixel") would be a guess. Android models are sent raw, not
// mapped to marketing names.
function detectHardware(ua: string, os: string | undefined, desktopModeIPad: boolean): Pick<UaDeviceInfo, 'model' | 'brand'> {
    if (os === 'iOS') {
        const model = desktopModeIPad ? 'iPad' : /\((iPhone|iPad|iPod)\b/.exec(ua)?.[1];
        return model ? { model, brand: 'Apple' } : {};
    }
    if (os === 'Android') {
        const model = androidModel(ua);
        return model ? { model } : {};
    }
    return {};
}

function androidModel(ua: string): string | undefined {
    // e.g. "(Linux; Android 13; SAMSUNG SM-S918B Build/TP1A.220624.014; wv)". One level
    // of nested parentheses is allowed for models like "moto g(30)".
    const segment = /Android[^;)]*;((?:[^()]|\([^()]*\))*)\)/.exec(ua);
    if (!segment) {
        return undefined;
    }
    for (const raw of segment[1].split(';')) {
        // Old WebView UAs append the firmware build and Samsung Internet prefixes the
        // maker; stripping both matches what Client Hints report for the same device.
        const token = raw.replace(/\s+Build\/.*$/, '').replace(/^\s*SAMSUNG\s+/i, '').trim();
        if (token && !NON_MODEL_ANDROID_TOKENS.test(token) && !LOCALE_TOKEN.test(token)) {
            return token;
        }
    }
    return undefined;
}

// Order matters: an iOS UA contains "like Mac OS X", an Android UA contains "Linux",
// and a ChromeOS UA contains "X11". Most specific first.
function detectOs(ua: string): Detected | null {
    if (/(iPhone|iPad|iPod)/.test(ua)) {
        const m = /CPU (?:iPhone )?OS (\d+)_(\d+)(?:_(\d+))?/.exec(ua);
        return { name: 'iOS', version: m ? [m[1], m[2], m[3]].filter(Boolean).join('.') : undefined };
    }
    const android = /Android (\d+(?:\.\d+)*)/.exec(ua);
    if (android) {
        return { name: 'Android', version: android[1] };
    }
    if (/CrOS/.test(ua)) {
        const m = /CrOS \S+ ([\d.]+)/.exec(ua);
        return { name: 'Chrome OS', version: m?.[1] };
    }
    const windows = /Windows NT ([\d.]+)/.exec(ua);
    if (windows) {
        return { name: 'Windows', version: WINDOWS_NT_VERSIONS[windows[1]] };
    }
    if (/Mac OS X|Macintosh/.test(ua)) {
        const m = /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/.exec(ua);
        const version = m ? [m[1], m[2], m[3]].filter(Boolean).join('.') : undefined;
        return { name: 'macOS', version: version && !FROZEN_MACOS_VERSIONS.has(version) ? version : undefined };
    }
    if (/Linux|X11/.test(ua)) {
        return { name: 'Linux' };
    }
    return null;
}

// Every Chromium UA ends in "Safari/…", and Edge/Opera/Samsung all carry a "Chrome/…"
// token, so each check must exclude the ones below it. Most specific first.
function detectBrowser(ua: string): Detected | null {
    const patterns: Array<[string, RegExp]> = [
        ['Edge', /Edg(?:A|iOS)?\/([\d.]+)/],
        ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/],
        ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
        ['Firefox', /(?:FxiOS|Firefox)\/([\d.]+)/],
        ['Chrome', /(?:CriOS|Chrome)\/([\d.]+)/],
        ['Safari', /Version\/([\d.]+).*\bSafari\//]
    ];

    for (const [name, pattern] of patterns) {
        const match = pattern.exec(ua);
        if (match) {
            return { name, version: match[1] };
        }
    }
    return null;
}

function detectCategory(ua: string, os: string | undefined, maxTouchPoints: number): string {
    if (/iPad/.test(ua)) {
        return 'tablet';
    }
    if (/iPhone|iPod/.test(ua)) {
        return 'mobile';
    }
    // Since iPadOS 13, an iPad in desktop mode sends a Macintosh UA that is otherwise
    // indistinguishable from a real Mac. Macs report maxTouchPoints 0.
    if (os === 'macOS' && maxTouchPoints > 1) {
        return 'tablet';
    }
    return deviceCategory(/Mobi/.test(ua), os);
}

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
}

interface Detected {
    name: string;
    version?: string;
}

// Windows reports a kernel version; GA4 users expect the marketing name.
const WINDOWS_NT_VERSIONS: Record<string, string> = {
    '10.0': '10',
    '6.3': '8.1',
    '6.2': '8',
    '6.1': '7',
    '6.0': 'Vista',
    '5.1': 'XP'
};

export function deviceFromUserAgent(ua: string, maxTouchPoints = 0): UaDeviceInfo {
    if (typeof ua !== 'string' || !ua) {
        return {};
    }

    const os = detectOs(ua);
    const browser = detectBrowser(ua);

    // Recognising neither means this is not a UA we understand. Returning {} keeps the
    // caller's "fill only what's missing" merge honest instead of asserting 'desktop'
    // for anything unfamiliar.
    if (!os && !browser) {
        return {};
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
    info.category = detectCategory(ua, os?.name, maxTouchPoints);
    return info;
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
        return { name: 'Windows', version: WINDOWS_NT_VERSIONS[windows[1]] ?? windows[1] };
    }
    if (/Mac OS X|Macintosh/.test(ua)) {
        const m = /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/.exec(ua);
        return { name: 'macOS', version: m ? [m[1], m[2], m[3]].filter(Boolean).join('.') : undefined };
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
    // Android tablets are exactly the Android UAs without the "Mobile" token.
    if (os === 'Android') {
        return /Mobi/.test(ua) ? 'mobile' : 'tablet';
    }
    if (/Mobi/.test(ua)) {
        return 'mobile';
    }
    // Since iPadOS 13, an iPad in desktop mode sends a Macintosh UA that is otherwise
    // indistinguishable from a real Mac. Macs report maxTouchPoints 0.
    if (os === 'macOS' && maxTouchPoints > 1) {
        return 'tablet';
    }
    return 'desktop';
}

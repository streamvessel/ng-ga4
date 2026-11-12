/**
 * Opt-in counterparts of gtag.js's Enhanced Measurement events. Every flag is
 * off by default, so upgrading changes nobody's event volume.
 *
 * Event names and parameters mirror what gtag.js sends, so GA4's built-in
 * reports and dimensions pick them up unchanged:
 * https://support.google.com/analytics/answer/9216061
 */
export interface NgGa4EnhancedMeasurement {
    /** `scroll` with `percent_scrolled: 90`, once per page view, when the user first reaches 90% depth. */
    scroll?: boolean;
    /** `click` with `outbound: true` for links to another host. */
    outboundClicks?: boolean;
    /** `file_download` for links whose path ends in one of Google's documented file extensions. */
    fileDownloads?: boolean;
    /** `view_search_results` when a page view's query has `q`, `s`, `search`, `query` or `keyword`. */
    siteSearch?: boolean;
    /** `form_start` on the first input into a form per page view, and `form_submit` on submit. */
    forms?: boolean;
    /**
     * `video_start`, `video_progress` (10/25/50/75%) and `video_complete` for
     * native `<video>` elements, with `video_provider: 'html5'`. gtag.js only
     * tracks embedded YouTube players; this covers the HTML5 player instead and
     * loads nothing.
     */
    video?: boolean;
}

export interface EnhancedMeasurementHost {
    /** Sends one event. Expected to apply the service's own enabled/consent/session handling. */
    track: (name: string, params: Record<string, unknown>) => void;
    /** page_location for an event, or `{}` when none should be sent. */
    pageLocation: () => { page_location?: string };
    /** The configured siteUrl; its host counts as "this site" alongside the document's own. */
    siteUrl?: string;
}

// Google's documented file_download extension list (answer 9216061), as a
// case-insensitive match on the end of the link's path.
const FILE_DOWNLOAD_EXTENSION =
    /\.(pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pp[st]x?|7z|pkg|rar|gz|zip|avi|mov|mp4|mpe?g|wmv|midi?|mp3|wav|wma)$/i;

// The query parameters gtag.js reads a search term from, in its order.
const SITE_SEARCH_PARAMS = ['q', 's', 'search', 'query', 'keyword'];

const SCROLL_THRESHOLD = 0.9;
// gtag.js's video_progress milestones, in percent.
const VIDEO_PROGRESS_MILESTONES = [10, 25, 50, 75];
// gtag.js truncates link text, button text and the search term to 100
// characters, the Measurement Protocol's limit for a parameter value.
const MAX_TEXT_LENGTH = 100;

/**
 * Delegated document/window listeners for the events in
 * {@link NgGa4EnhancedMeasurement}. Plain class, not a service: the caller owns
 * its lifetime (`start()` in init, `stop()` in ngOnDestroy) and decides which
 * zone it runs in.
 *
 * Does nothing when `document`/`window` are absent (SSR, or an MV3 service
 * worker), or when every flag is off, so the caller need not guard.
 */
export class EnhancedMeasurement {
    private readonly listeners: Array<{ target: EventTarget; type: string; fn: EventListener; capture: boolean }> = [];
    private readonly siteHostname: string | null;
    private scrolled = false;
    private startedForms = new WeakSet<HTMLFormElement>();
    private videos = new WeakMap<HTMLVideoElement, VideoState>();

    constructor(
        private readonly options: NgGa4EnhancedMeasurement,
        private readonly host: EnhancedMeasurementHost,
        // null, not undefined, means "absent": undefined would select the default.
        private readonly doc: Document | null = typeof document !== 'undefined' ? document : null,
        private readonly win: Window | null = typeof window !== 'undefined' ? window : null
    ) {
        // Lowercased: URL only folds case for http(s) and the other special
        // schemes, and a siteUrl such as capacitor://MyApp is not one.
        this.siteHostname = host.siteUrl ? parseUrl(host.siteUrl)?.hostname.toLowerCase() ?? null : null;
    }

    get started(): boolean {
        return this.listeners.length > 0;
    }

    start(): void {
        const { doc, win, options } = this;
        if (!doc || !win || this.started) {
            return;
        }
        if (options.scroll) {
            this.listen(win, 'scroll', () => this.onScroll(doc, win), false, true);
        }
        if (options.outboundClicks || options.fileDownloads) {
            // Capture phase, so an app handler calling stopPropagation() can't hide
            // the click. auxclick covers middle-click "open in new tab".
            this.listen(doc, 'click', e => this.onClick(e as MouseEvent, win), true);
            this.listen(doc, 'auxclick', e => this.onClick(e as MouseEvent, win), true);
        }
        if (options.forms) {
            // `input` covers typing, `change` covers selects, checkboxes and
            // radios in browsers that don't fire `input` for them. Focus alone is
            // deliberately not interaction: autofocus would report a form_start on
            // every page that has a search box.
            this.listen(doc, 'input', e => this.onFormInteraction(e), true);
            this.listen(doc, 'change', e => this.onFormInteraction(e), true);
            this.listen(doc, 'submit', e => this.onSubmit(e as SubmitEvent), true);
        }
        if (options.video) {
            // Media events don't bubble, but a capture listener on document still
            // sees them for every <video> in the light DOM.
            this.listen(doc, 'play', e => this.onVideoPlay(e, win), true);
            this.listen(doc, 'timeupdate', e => this.onVideoTimeUpdate(e, win), true);
            this.listen(doc, 'ended', e => this.onVideoEnded(e, win), true);
        }
    }

    stop(): void {
        for (const { target, type, fn, capture } of this.listeners.splice(0)) {
            target.removeEventListener(type, fn, capture);
        }
    }

    /**
     * Call after each page view is sent: resets per-page state (scroll depth,
     * forms started) and sends `view_search_results` for a search URL.
     *
     * The search term is read from the path the app reported, not from
     * `window.location`, so whatever the app strips from the paths it reports
     * stays stripped here too.
     */
    pageViewed(pagePath: string): void {
        this.scrolled = false;
        this.startedForms = new WeakSet();
        this.videos = new WeakMap();
        if (!this.options.siteSearch) {
            return;
        }
        const term = searchTermFromPath(pagePath);
        if (term !== null) {
            this.send('view_search_results', { search_term: term });
        }
    }

    // Every event carries page_location, so it is added here, once.
    private send(name: string, params: Record<string, unknown>): void {
        this.host.track(name, { ...params, ...this.host.pageLocation() });
    }

    private listen(target: EventTarget, type: string, fn: EventListener, capture: boolean, passive = false): void {
        target.addEventListener(type, fn, passive ? { capture, passive } : capture);
        this.listeners.push({ target, type, fn, capture });
    }

    private onScroll(doc: Document, win: Window): void {
        if (this.scrolled) {
            return;
        }
        // In standards mode the root's scrollHeight already covers <body>; only
        // quirks mode puts the document's height on body instead.
        const scrollHeight = doc.compatMode === 'BackCompat' && doc.body
            ? doc.body.scrollHeight
            : doc.documentElement.scrollHeight;
        if (!scrollHeight) {
            return;
        }
        if ((win.scrollY + win.innerHeight) / scrollHeight >= SCROLL_THRESHOLD) {
            this.scrolled = true;
            this.send('scroll', { percent_scrolled: 90 });
        }
    }

    private onClick(event: MouseEvent, win: Window): void {
        // auxclick also fires for right-click, which opens a context menu, not the link.
        if (event.type === 'auxclick' && event.button !== 1) {
            return;
        }
        const link = findLink(event);
        const url = link ? parseUrl(link.href) : null;
        if (!link || !url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
            return;
        }
        const common = {
            link_id: link.getAttribute('id') ?? '',
            link_classes: link.getAttribute('class') ?? '',
            link_url: url.href
        };
        // A download takes precedence over an outbound click, as in gtag.js: one
        // click, one event.
        const extension = this.options.fileDownloads ? FILE_DOWNLOAD_EXTENSION.exec(url.pathname)?.[1] : undefined;
        if (extension) {
            this.send('file_download', {
                ...common,
                file_extension: extension.toLowerCase(),
                file_name: url.pathname,
                link_text: truncate(normaliseText(link.textContent))
            });
            return;
        }
        // http(s) hostnames are already lowercase, from URL and Location alike.
        if (this.options.outboundClicks && url.hostname !== win.location.hostname && url.hostname !== this.siteHostname) {
            this.send('click', { ...common, link_domain: url.hostname, outbound: true });
        }
    }

    private onFormInteraction(event: Event): void {
        const form = formOf(event.target);
        if (!form || this.startedForms.has(form)) {
            return;
        }
        this.startedForms.add(form);
        this.send('form_start', formParams(form));
    }

    private onSubmit(event: SubmitEvent): void {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
            return;
        }
        const submitter = event.submitter;
        const submitText = submitter
            ? normaliseText(submitter instanceof HTMLInputElement ? submitter.value : submitter.textContent)
            : '';
        this.send('form_submit', {
            ...formParams(form),
            ...(submitText ? { form_submit_text: truncate(submitText) } : {})
        });
    }

    // Starts on the first play of a source, and again on a replay after it
    // ended. A pause and resume is the same view, so it doesn't count.
    private onVideoPlay(event: Event, win: Window): void {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) {
            return;
        }
        const state = this.videos.get(video);
        if (state && state.src === video.currentSrc && !state.ended) {
            return;
        }
        this.videos.set(video, { src: video.currentSrc, milestones: new Set(), ended: false });
        this.send('video_start', videoParams(video, win, 0));
    }

    // A seek past several milestones sends only the furthest, so jumping to the
    // end doesn't send four events at once; the ones skipped count as passed.
    private onVideoTimeUpdate(event: Event, win: Window): void {
        const tracked = this.trackedVideo(event);
        if (!tracked || !isFinite(tracked.video.duration) || tracked.video.duration <= 0) {
            return;
        }
        const { video, state } = tracked;
        const percent = (video.currentTime / video.duration) * 100;
        const reached = VIDEO_PROGRESS_MILESTONES.filter(m => percent >= m && !state.milestones.has(m));
        if (reached.length) {
            reached.forEach(m => state.milestones.add(m));
            this.send('video_progress', videoParams(video, win, reached[reached.length - 1]));
        }
    }

    private onVideoEnded(event: Event, win: Window): void {
        const tracked = this.trackedVideo(event);
        if (tracked) {
            tracked.state.ended = true;
            this.send('video_complete', videoParams(tracked.video, win, 100));
        }
    }

    // A video already started and not yet ended; progress and completion only
    // count for those.
    private trackedVideo(event: Event): { video: HTMLVideoElement; state: VideoState } | null {
        const video = event.target;
        const state = video instanceof HTMLVideoElement ? this.videos.get(video) : undefined;
        return video instanceof HTMLVideoElement && state && !state.ended ? { video, state } : null;
    }
}

interface VideoState {
    src: string;
    milestones: Set<number>;
    ended: boolean;
}

// gtag.js's video parameters. video_url drops the query and fragment, which
// on a CDN often hold a signed token, and is left empty for blob: and other
// non-http sources (MSE players such as hls.js), where it would mean nothing.
function videoParams(video: HTMLVideoElement, win: Window, percent: number): Record<string, unknown> {
    const url = parseUrl(video.currentSrc);
    const rect = video.getBoundingClientRect();
    const duration = isFinite(video.duration) ? Math.round(video.duration) : undefined;
    return {
        video_provider: 'html5',
        video_title: truncate(normaliseText(video.getAttribute('title') ?? video.getAttribute('aria-label'))),
        video_url: url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin + url.pathname : '',
        video_current_time: Math.floor(video.currentTime),
        ...(duration !== undefined ? { video_duration: duration } : {}),
        video_percent: percent,
        visible: rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth
            && video.ownerDocument.visibilityState !== 'hidden'
    };
}

/** The search term in a reported page path, or null when it has none. */
export function searchTermFromPath(pagePath: string): string | null {
    // Base only resolves relative paths; an absolute URL keeps its own.
    const params = parseUrl(pagePath, 'http://localhost')?.searchParams;
    for (const name of SITE_SEARCH_PARAMS) {
        const value = params?.get(name)?.trim();
        if (value) {
            return truncate(value);
        }
    }
    return null;
}

function parseUrl(url: string, base?: string): URL | null {
    try {
        return new URL(url, base);
    } catch {
        return null;
    }
}

// composedPath() rather than event.target: a link inside an open shadow root
// retargets to its host by the time the event reaches document.
function findLink(event: Event): HTMLAnchorElement | HTMLAreaElement | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
        if ((node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.hasAttribute('href')) {
            return node;
        }
    }
    return null;
}

function formOf(target: EventTarget | null): HTMLFormElement | null {
    if (!(target instanceof Element)) {
        return null;
    }
    // `.form` honours the `form="..."` attribute on fields outside the <form>.
    // Anything else falls back to the ancestor form: a web component's `form`
    // is often just the reflected attribute string, and a control whose `form`
    // attribute names a missing id still sits inside the form the user sees.
    const owner = (target as { form?: unknown }).form;
    return owner instanceof HTMLFormElement ? owner : target.closest('form');
}

// getAttribute(), not form.id / form.name / form.action: a field named "id",
// "name" or "action" shadows those properties with the field element itself.
// form_destination is only sent for an explicit action, because the implicit one
// is the current URL, unfiltered — the address siteUrl users rely on us not to send.
function formParams(form: HTMLFormElement): Record<string, string> {
    const action = form.getAttribute('action');
    return {
        form_id: form.getAttribute('id') ?? '',
        form_name: form.getAttribute('name') ?? '',
        form_destination: action ? parseUrl(action, form.ownerDocument.baseURI)?.href ?? action : ''
    };
}

function normaliseText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

// Drops a high surrogate left dangling by the cut, rather than send half an emoji.
function truncate(text: string): string {
    return text.slice(0, MAX_TEXT_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
}

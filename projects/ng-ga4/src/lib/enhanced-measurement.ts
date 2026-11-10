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
}

export type EnhancedMeasurementTrack = (name: string, params: Record<string, unknown>) => void;

export interface EnhancedMeasurementHost {
    /** Sends one event. Expected to apply the service's own enabled/consent/session handling. */
    track: EnhancedMeasurementTrack;
    /** page_location for an event, or `{}` when none should be sent. */
    pageLocation: () => { page_location?: string };
    /** Hostnames treated as "this site" in addition to the document's own. */
    internalHostnames: string[];
}

// Google's documented file_download extension list (answer 9216061), as a
// case-insensitive match on the end of the link's path.
export const FILE_DOWNLOAD_EXTENSION =
    /\.(pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pp[st]x?|7z|pkg|rar|gz|zip|avi|mov|mp4|mpe?g|wmv|midi?|mp3|wav|wma)$/i;

// The query parameters gtag.js reads a search term from, in its order.
export const SITE_SEARCH_PARAMS = ['q', 's', 'search', 'query', 'keyword'];

const SCROLL_THRESHOLD = 0.9;
// Measurement Protocol parameter values are capped at 100 characters; gtag.js
// truncates link and button text to the same length.
const MAX_TEXT_LENGTH = 100;

/**
 * Delegated document/window listeners for the events in
 * {@link NgGa4EnhancedMeasurement}. Plain class, not a service: the caller owns
 * its lifetime (`start()` in init, `stop()` in ngOnDestroy) and decides which
 * zone it runs in.
 *
 * Does nothing when `document`/`window` are absent (SSR, or an MV3 service
 * worker), so the caller need not guard.
 */
export class EnhancedMeasurement {
    private readonly listeners: Array<{ target: EventTarget; type: string; fn: EventListener; capture: boolean }> = [];
    private scrolled = false;
    private startedForms = new WeakSet<HTMLFormElement>();

    constructor(
        private readonly options: NgGa4EnhancedMeasurement,
        private readonly host: EnhancedMeasurementHost,
        // null, not undefined, means "absent": undefined would select the default.
        private readonly doc: Document | null = typeof document !== 'undefined' ? document : null,
        private readonly win: Window | null = typeof window !== 'undefined' ? window : null
    ) {}

    /** True when at least one event is switched on. */
    static anyEnabled(options: NgGa4EnhancedMeasurement | undefined): boolean {
        return !!options && Object.values(options).some(Boolean);
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
            this.listen(win, 'scroll', () => this.onScroll(), false, true);
        }
        if (options.outboundClicks || options.fileDownloads) {
            // Capture phase, so an app handler calling stopPropagation() can't hide
            // the click. auxclick covers middle-click "open in new tab".
            this.listen(doc, 'click', e => this.onClick(e as MouseEvent), true);
            this.listen(doc, 'auxclick', e => this.onClick(e as MouseEvent), true);
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
        if (!this.options.siteSearch) {
            return;
        }
        const term = searchTermFromPath(pagePath);
        if (term !== null) {
            this.host.track('view_search_results', { search_term: term, ...this.host.pageLocation() });
        }
    }

    private listen(target: EventTarget, type: string, fn: EventListener, capture: boolean, passive = false): void {
        target.addEventListener(type, fn, passive ? { capture, passive } : capture);
        this.listeners.push({ target, type, fn, capture });
    }

    private onScroll(): void {
        if (this.scrolled || !this.doc || !this.win) {
            return;
        }
        const root = this.doc.documentElement;
        const scrollHeight = Math.max(root.scrollHeight, this.doc.body?.scrollHeight ?? 0);
        if (!scrollHeight) {
            return;
        }
        const viewportBottom = (this.win.scrollY ?? root.scrollTop) + this.win.innerHeight;
        if (viewportBottom / scrollHeight >= SCROLL_THRESHOLD) {
            this.scrolled = true;
            this.host.track('scroll', { percent_scrolled: 90, ...this.host.pageLocation() });
        }
    }

    private onClick(event: MouseEvent): void {
        // auxclick also fires for right-click, which opens a context menu, not the link.
        if (event.type === 'auxclick' && event.button !== 1) {
            return;
        }
        const link = findLink(event);
        if (!link) {
            return;
        }
        let url: URL;
        try {
            url = new URL(link.href);
        } catch {
            return;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
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
            this.host.track('file_download', {
                ...common,
                file_extension: extension.toLowerCase(),
                file_name: url.pathname,
                link_text: truncate(normaliseText(link.textContent)),
                ...this.host.pageLocation()
            });
            return;
        }
        if (this.options.outboundClicks && this.isOutbound(url)) {
            this.host.track('click', {
                ...common,
                link_domain: url.hostname,
                outbound: true,
                ...this.host.pageLocation()
            });
        }
    }

    private isOutbound(url: URL): boolean {
        const host = url.hostname.toLowerCase();
        const own = this.win?.location?.hostname?.toLowerCase();
        return host !== own && !this.host.internalHostnames.some(h => h.toLowerCase() === host);
    }

    private onFormInteraction(event: Event): void {
        const form = formOf(event.target);
        if (!form || this.startedForms.has(form)) {
            return;
        }
        this.startedForms.add(form);
        this.host.track('form_start', { ...formParams(form), ...this.host.pageLocation() });
    }

    private onSubmit(event: SubmitEvent): void {
        const form = event.target;
        if (!isForm(form)) {
            return;
        }
        const submitter = event.submitter as HTMLElement | null | undefined;
        const submitText = submitter
            ? normaliseText(submitter instanceof HTMLInputElement ? submitter.value : submitter.textContent)
            : '';
        this.host.track('form_submit', {
            ...formParams(form),
            ...(submitText ? { form_submit_text: truncate(submitText) } : {}),
            ...this.host.pageLocation()
        });
    }
}

/** The search term in a reported page path, or null when it has none. */
export function searchTermFromPath(pagePath: string): string | null {
    let params: URLSearchParams;
    try {
        // Base only resolves relative paths; an absolute URL keeps its own.
        params = new URL(pagePath, 'http://localhost').searchParams;
    } catch {
        return null;
    }
    for (const name of SITE_SEARCH_PARAMS) {
        const value = params.get(name)?.trim();
        if (value) {
            return truncate(value);
        }
    }
    return null;
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

function isForm(node: unknown): node is HTMLFormElement {
    return typeof HTMLFormElement !== 'undefined' && node instanceof HTMLFormElement;
}

function formOf(target: EventTarget | null): HTMLFormElement | null {
    if (!target || typeof Element === 'undefined' || !(target instanceof Element)) {
        return null;
    }
    // `.form` honours the `form="..."` attribute on fields outside the <form>.
    const owner = (target as Element & { form?: unknown }).form;
    if (isForm(owner)) {
        return owner;
    }
    return target.closest('form');
}

// getAttribute(), not form.id / form.name / form.action: a field named "id",
// "name" or "action" shadows those properties with the field element itself.
// form_destination is only sent for an explicit action, because the implicit one
// is the current URL, unfiltered — the address siteUrl users rely on us not to send.
function formParams(form: HTMLFormElement): Record<string, string> {
    const action = form.getAttribute('action');
    let destination = '';
    if (action) {
        try {
            destination = new URL(action, form.ownerDocument.baseURI).href;
        } catch {
            destination = action;
        }
    }
    return {
        form_id: form.getAttribute('id') ?? '',
        form_name: form.getAttribute('name') ?? '',
        form_destination: destination
    };
}

function normaliseText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text: string): string {
    return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

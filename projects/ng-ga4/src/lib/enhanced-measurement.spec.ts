import { EnhancedMeasurement, EnhancedMeasurementHost, NgGa4EnhancedMeasurement, searchTermFromPath } from './enhanced-measurement';

describe('EnhancedMeasurement', () => {
    let sent: Array<{ name: string; params: Record<string, unknown> }>;
    let host: EnhancedMeasurementHost;
    let em: EnhancedMeasurement | null;
    let fixture: HTMLDivElement;

    // Real document for click/form delegation; a stand-in window so the page's
    // own hostname and scroll geometry are under the spec's control.
    const fakeWindow = (overrides: Record<string, unknown> = {}) =>
        Object.assign(new EventTarget(), { location: { hostname: 'example.com' }, scrollY: 0, innerHeight: 500 }, overrides) as unknown as Window;

    function create(options: NgGa4EnhancedMeasurement, win: Window = fakeWindow(), doc: Document = document): EnhancedMeasurement {
        em = new EnhancedMeasurement(options, host, doc, win);
        em.start();
        return em;
    }

    function addLink(href: string, attrs: Record<string, string> = {}, text = 'Link'): HTMLAnchorElement {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = text;
        for (const [k, v] of Object.entries(attrs)) {
            a.setAttribute(k, v);
        }
        // Keep the Karma page where it is.
        a.addEventListener('click', e => e.preventDefault());
        a.addEventListener('auxclick', e => e.preventDefault());
        fixture.appendChild(a);
        return a;
    }

    function click(el: Element, type: 'click' | 'auxclick' = 'click', button = 0): void {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button }));
    }

    beforeEach(() => {
        sent = [];
        host = {
            track: (name, params) => sent.push({ name, params }),
            pageLocation: () => ({ page_location: 'https://example.com/here' })
        };
        em = null;
        fixture = document.createElement('div');
        document.body.appendChild(fixture);
    });

    afterEach(() => {
        em?.stop();
        fixture.remove();
    });

    describe('lifecycle', () => {
        it('registers nothing when no document or window exists (SSR, MV3 worker)', () => {
            em = new EnhancedMeasurement({ scroll: true, forms: true, outboundClicks: true }, host, null, null);
            em.start();
            expect(em.started).toBe(false);
        });

        it('registers nothing for an all-off config', () => {
            create({});
            expect(em!.started).toBe(false);
        });

        it('removes every listener on stop()', () => {
            create({ outboundClicks: true, forms: true });
            em!.stop();
            click(addLink('https://other.test/'));
            const form = document.createElement('form');
            fixture.appendChild(form);
            form.dispatchEvent(new Event('submit', { bubbles: true }));

            expect(sent).toEqual([]);
            expect(em!.started).toBe(false);
        });

        it('does not register twice when started twice', () => {
            create({ outboundClicks: true });
            em!.start();
            click(addLink('https://other.test/'));
            expect(sent.length).toBe(1);
        });
    });

    describe('scroll', () => {
        let doc: Document;
        let win: Window & { scrollY: number };

        beforeEach(() => {
            doc = { documentElement: { scrollHeight: 2000, scrollTop: 0 }, body: null } as unknown as Document;
            win = fakeWindow({ innerHeight: 500 }) as Window & { scrollY: number };
            create({ scroll: true }, win, doc);
        });

        function scrollTo(y: number): void {
            win.scrollY = y;
            win.dispatchEvent(new Event('scroll'));
        }

        it('does not fire before 90% depth', () => {
            scrollTo(1250); // bottom at 1750 / 2000 = 87.5%
            expect(sent).toEqual([]);
        });

        it('fires scroll with percent_scrolled 90 at 90% depth', () => {
            scrollTo(1300); // bottom at 1800 / 2000
            expect(sent).toEqual([{ name: 'scroll', params: { percent_scrolled: 90, page_location: 'https://example.com/here' } }]);
        });

        it('fires once per page, and again after the next page view', () => {
            scrollTo(1500);
            scrollTo(0);
            scrollTo(1500);
            expect(sent.length).toBe(1);

            em!.pageViewed('/next');
            scrollTo(1500);
            expect(sent.length).toBe(2);
        });
    });

    describe('outbound clicks', () => {
        beforeEach(() => create({ outboundClicks: true }));

        it('sends click with gtag parameters for a link to another host', () => {
            click(addLink('https://other.test/path?x=1', { id: 'cta', class: 'btn primary' }));

            expect(sent).toEqual([{
                name: 'click',
                params: {
                    link_id: 'cta',
                    link_classes: 'btn primary',
                    link_url: 'https://other.test/path?x=1',
                    link_domain: 'other.test',
                    outbound: true,
                    page_location: 'https://example.com/here'
                }
            }]);
        });

        it('finds the link from a click on a nested element', () => {
            const a = addLink('https://other.test/');
            const span = document.createElement('span');
            a.appendChild(span);
            click(span);
            expect(sent.map(e => e.name)).toEqual(['click']);
        });

        it('ignores links to the same host', () => {
            click(addLink('https://example.com/elsewhere'));
            expect(sent).toEqual([]);
        });

        it('ignores non-http(s) links such as mailto:', () => {
            click(addLink('mailto:a@b.test'));
            expect(sent).toEqual([]);
        });

        it('treats the siteUrl host as the same site', () => {
            em!.stop();
            host.siteUrl = 'https://www.mysite.test/app';
            create({ outboundClicks: true });
            click(addLink('https://www.mysite.test/a'));
            expect(sent).toEqual([]);
        });

        it('compares a non-special siteUrl host case-insensitively', () => {
            em!.stop();
            host.siteUrl = 'capacitor://MyApp';
            create({ outboundClicks: true });
            const a = addLink('https://other.test/');
            a.href = 'capacitor://myapp/page';
            click(a);
            expect(sent).toEqual([]);
        });

        it('counts middle-click but not right-click', () => {
            const a = addLink('https://other.test/');
            click(a, 'auxclick', 2);
            expect(sent).toEqual([]);
            click(a, 'auxclick', 1);
            expect(sent.length).toBe(1);
        });

        it('sees the click even if the app stops propagation', () => {
            const a = addLink('https://other.test/');
            a.addEventListener('click', e => e.stopPropagation());
            click(a);
            expect(sent.length).toBe(1);
        });

        it('does not send file_download when only outbound clicks are on', () => {
            click(addLink('https://other.test/report.pdf'));
            expect(sent.map(e => e.name)).toEqual(['click']);
        });
    });

    describe('file downloads', () => {
        beforeEach(() => create({ fileDownloads: true, outboundClicks: true }));

        it('sends file_download with gtag parameters', () => {
            click(addLink('https://example.com/files/Report.PDF?v=2', { id: 'dl', class: 'download' }, '  Annual\n report '));

            expect(sent).toEqual([{
                name: 'file_download',
                params: {
                    link_id: 'dl',
                    link_classes: 'download',
                    link_url: 'https://example.com/files/Report.PDF?v=2',
                    file_extension: 'pdf',
                    file_name: '/files/Report.PDF',
                    link_text: 'Annual report',
                    page_location: 'https://example.com/here'
                }
            }]);
        });

        it('matches every extension on Google\'s documented list', () => {
            const exts = ['pdf', 'xls', 'xlsx', 'doc', 'docx', 'txt', 'rtf', 'csv', 'exe', 'key', 'pps', 'ppt', 'pptx',
                '7z', 'pkg', 'rar', 'gz', 'zip', 'avi', 'mov', 'mp4', 'mpeg', 'mpg', 'wmv', 'mid', 'midi', 'mp3', 'wav', 'wma'];
            for (const ext of exts) {
                click(addLink(`https://example.com/f.${ext}`));
            }
            expect(sent.map(e => e.params['file_extension'])).toEqual(exts);
        });

        it('ignores other extensions and extension-like query strings', () => {
            click(addLink('https://example.com/page.html'));
            click(addLink('https://example.com/page?file=x.pdf'));
            expect(sent).toEqual([]);
        });

        it('sends file_download instead of, not as well as, an outbound click', () => {
            click(addLink('https://cdn.other.test/a.zip'));
            expect(sent.map(e => e.name)).toEqual(['file_download']);
        });

        it('truncates link_text to 100 characters', () => {
            click(addLink('https://example.com/a.pdf', {}, 'x'.repeat(150)));
            expect((sent[0].params['link_text'] as string).length).toBe(100);
        });

        it('does not split a surrogate pair when truncating', () => {
            click(addLink('https://example.com/a.pdf', {}, 'x'.repeat(99) + '\u{1F600}tail'));
            expect(sent[0].params['link_text']).toBe('x'.repeat(99));
        });
    });

    describe('site search', () => {
        it('sends view_search_results with search_term from the page path', () => {
            create({ siteSearch: true });
            em!.pageViewed('/search?category=a&q=red%20shoes');
            expect(sent).toEqual([{
                name: 'view_search_results',
                params: { search_term: 'red shoes', page_location: 'https://example.com/here' }
            }]);
        });

        it('reads q, s, search, query and keyword, in that order', () => {
            expect(searchTermFromPath('/?s=one')).toBe('one');
            expect(searchTermFromPath('/?search=one')).toBe('one');
            expect(searchTermFromPath('/?query=one')).toBe('one');
            expect(searchTermFromPath('/?keyword=one')).toBe('one');
            expect(searchTermFromPath('/?keyword=two&q=one')).toBe('one');
            expect(searchTermFromPath('https://example.com/x?q=abs')).toBe('abs');
        });

        it('sends nothing for a path without a non-empty search parameter', () => {
            create({ siteSearch: true });
            em!.pageViewed('/products');
            em!.pageViewed('/search?q=%20');
            em!.pageViewed('/search?term=x');
            expect(sent).toEqual([]);
        });

        it('sends nothing when site search is off', () => {
            create({ scroll: true });
            em!.pageViewed('/search?q=x');
            expect(sent).toEqual([]);
        });
    });

    describe('forms', () => {
        let form: HTMLFormElement;
        let input: HTMLInputElement;

        beforeEach(() => {
            create({ forms: true });
            form = document.createElement('form');
            form.setAttribute('id', 'signup');
            form.setAttribute('name', 'signupForm');
            form.setAttribute('action', '/subscribe');
            input = document.createElement('input');
            form.appendChild(input);
            fixture.appendChild(form);
        });

        const formParams = () => ({
            form_id: 'signup',
            form_name: 'signupForm',
            form_destination: new URL('/subscribe', document.baseURI).href,
            page_location: 'https://example.com/here'
        });

        it('sends form_start on the first input, once per form per page', () => {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            expect(sent).toEqual([{ name: 'form_start', params: formParams() }]);

            em!.pageViewed('/again');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            expect(sent.length).toBe(2);
        });

        it('does not treat focus alone as starting a form', () => {
            input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
            expect(sent).toEqual([]);
        });

        it('honours the form attribute on fields outside the form', () => {
            const outside = document.createElement('input');
            outside.setAttribute('form', 'signup');
            fixture.appendChild(outside);
            outside.dispatchEvent(new Event('input', { bubbles: true }));
            expect(sent[0].params['form_id']).toBe('signup');
        });

        it('falls back to the enclosing form when a field\'s form attribute names no form', () => {
            const dangling = document.createElement('input');
            dangling.setAttribute('form', 'no-such-form');
            form.appendChild(dangling);
            dangling.dispatchEvent(new Event('input', { bubbles: true }));
            expect(sent[0].params['form_id']).toBe('signup');
        });

        it('falls back to the enclosing form for an element whose form property is not a form', () => {
            const custom = document.createElement('div');
            (custom as unknown as { form: string }).form = '';
            form.appendChild(custom);
            custom.dispatchEvent(new Event('input', { bubbles: true }));
            expect(sent[0].params['form_id']).toBe('signup');
        });

        it('ignores input outside any form', () => {
            const loose = document.createElement('input');
            fixture.appendChild(loose);
            loose.dispatchEvent(new Event('input', { bubbles: true }));
            expect(sent).toEqual([]);
        });

        it('sends form_submit with the submitter text', () => {
            const button = document.createElement('button');
            button.textContent = ' Sign up ';
            form.appendChild(button);
            form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button }));

            expect(sent).toEqual([{ name: 'form_submit', params: { ...formParams(), form_submit_text: 'Sign up' } }]);
        });

        it('reads an input submitter\'s value', () => {
            const button = document.createElement('input');
            button.type = 'submit';
            button.value = 'Go';
            form.appendChild(button);
            form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button }));
            expect(sent[0].params['form_submit_text']).toBe('Go');
        });

        it('omits form_destination without an explicit action, and is not fooled by fields named id/name/action', () => {
            const bare = document.createElement('form');
            for (const n of ['id', 'name', 'action']) {
                const field = document.createElement('input');
                field.name = n;
                bare.appendChild(field);
            }
            fixture.appendChild(bare);
            bare.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            expect(sent).toEqual([{
                name: 'form_submit',
                params: { form_id: '', form_name: '', form_destination: '', page_location: 'https://example.com/here' }
            }]);
        });
    });

    describe('video', () => {
        let video: HTMLVideoElement;
        let rect: Partial<DOMRect>;

        // duration, currentTime and currentSrc are driven by real media loading;
        // own properties shadow the prototype accessors so the spec sets them.
        function setMedia(props: { duration?: number; currentTime?: number; currentSrc?: string }): void {
            for (const [key, value] of Object.entries(props)) {
                Object.defineProperty(video, key, { value, configurable: true, writable: true });
            }
        }

        function fire(type: 'play' | 'timeupdate' | 'ended'): void {
            video.dispatchEvent(new Event(type));
        }

        function at(seconds: number): void {
            setMedia({ currentTime: seconds });
            fire('timeupdate');
        }

        beforeEach(() => {
            create({ video: true }, fakeWindow({ innerHeight: 800, innerWidth: 1200 }));
            video = document.createElement('video');
            video.setAttribute('title', ' Product  tour ');
            rect = { top: 10, left: 10, bottom: 300, right: 500 };
            video.getBoundingClientRect = () => rect as DOMRect;
            setMedia({ duration: 100.4, currentTime: 0, currentSrc: 'https://cdn.example.com/v/tour.mp4?token=secret#t=5' });
            fixture.appendChild(video);
        });

        it('sends video_start with gtag parameters on the first play', () => {
            fire('play');
            expect(sent).toEqual([{
                name: 'video_start',
                params: {
                    video_provider: 'html5',
                    video_title: 'Product tour',
                    video_url: 'https://cdn.example.com/v/tour.mp4',
                    video_current_time: 0,
                    video_duration: 100,
                    video_percent: 0,
                    visible: document.visibilityState !== 'hidden',
                    page_location: 'https://example.com/here'
                }
            }]);
        });

        it('does not restart on pause and resume', () => {
            fire('play');
            at(30);
            fire('play');
            expect(sent.filter(e => e.name === 'video_start').length).toBe(1);
        });

        it('sends each progress milestone once, as playback passes it', () => {
            fire('play');
            for (const t of [5, 11, 12, 26, 51, 74, 76, 90]) {
                at(t);
            }
            const progress = sent.filter(e => e.name === 'video_progress');
            expect(progress.map(e => e.params['video_percent'])).toEqual([10, 25, 50, 75]);
            expect(progress[0].params['video_current_time']).toBe(11);
        });

        it('sends only the furthest milestone after a seek past several', () => {
            fire('play');
            at(60);
            at(80);
            expect(sent.filter(e => e.name === 'video_progress').map(e => e.params['video_percent'])).toEqual([50, 75]);
        });

        it('sends video_complete on ended, once, and nothing after it', () => {
            fire('play');
            setMedia({ currentTime: 100.4 });
            fire('ended');
            fire('ended');
            at(100);
            expect(sent.map(e => e.name)).toEqual(['video_start', 'video_complete']);
            expect(sent[1].params['video_percent']).toBe(100);
        });

        it('starts again on a replay after it ended', () => {
            fire('play');
            fire('ended');
            setMedia({ currentTime: 0 });
            fire('play');
            at(11);
            expect(sent.map(e => e.name)).toEqual(['video_start', 'video_complete', 'video_start', 'video_progress']);
        });

        it('starts again when the source changes', () => {
            fire('play');
            setMedia({ currentSrc: 'https://cdn.example.com/v/other.mp4' });
            fire('play');
            expect(sent.map(e => e.params['video_url'])).toEqual([
                'https://cdn.example.com/v/tour.mp4',
                'https://cdn.example.com/v/other.mp4'
            ]);
        });

        it('starts again after the next page view', () => {
            fire('play');
            em!.pageViewed('/next');
            fire('play');
            expect(sent.filter(e => e.name === 'video_start').length).toBe(2);
        });

        it('ignores progress and completion for a video that never started', () => {
            at(50);
            fire('ended');
            expect(sent).toEqual([]);
        });

        it('sends no progress or duration for a live stream', () => {
            setMedia({ duration: Infinity });
            fire('play');
            at(500);
            expect(sent.map(e => e.name)).toEqual(['video_start']);
            expect('video_duration' in sent[0].params).toBe(false);
        });

        it('leaves video_url empty for a blob: source', () => {
            setMedia({ currentSrc: 'blob:https://example.com/1234' });
            fire('play');
            expect(sent[0].params['video_url']).toBe('');
        });

        it('falls back to aria-label for the title', () => {
            video.removeAttribute('title');
            video.setAttribute('aria-label', 'Intro');
            fire('play');
            expect(sent[0].params['video_title']).toBe('Intro');
        });

        it('reports visible: false for a video outside the viewport', () => {
            rect = { top: 900, left: 10, bottom: 1200, right: 500 };
            fire('play');
            expect(sent[0].params['visible']).toBe(false);
        });

        it('ignores <audio>', () => {
            const audio = document.createElement('audio');
            fixture.appendChild(audio);
            audio.dispatchEvent(new Event('play'));
            expect(sent).toEqual([]);
        });

        it('registers nothing when video is off', () => {
            em!.stop();
            create({ forms: true });
            fire('play');
            expect(sent).toEqual([]);
        });
    });
});

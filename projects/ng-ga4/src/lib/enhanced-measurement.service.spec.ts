import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { NgGa4Service } from './ng-ga4.service';
import { NG_GA4_CONFIG, NgGa4Config } from './ng-ga4.config';

// How the service wires EnhancedMeasurement in: off by default, events go out
// through trackEvent (session, enabled flag, page_location), and listeners are
// removed on destroy. The listeners themselves are covered in enhanced-measurement.spec.ts.
describe('NgGa4Service enhanced measurement wiring', () => {
    let service: NgGa4Service;
    let httpMock: HttpTestingController;
    let fixture: HTMLDivElement;

    function configure(config: Partial<NgGa4Config>, platformId?: string): void {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule],
            providers: [
                NgGa4Service,
                { provide: Router, useValue: { events: new Subject<any>().asObservable() } },
                {
                    provide: NG_GA4_CONFIG,
                    useValue: { measurementId: 'G-TEST', apiSecret: 's', enabled: true, isExtension: false, transport: 'xhr', ...config }
                },
                ...(platformId ? [{ provide: PLATFORM_ID, useValue: platformId }] : [])
            ]
        });
        service = TestBed.inject(NgGa4Service);
        httpMock = TestBed.inject(HttpTestingController);
    }

    function sentEvents(): Array<{ name: string; params: Record<string, any> }> {
        return httpMock.match(r => r.url.includes('mp/collect')).flatMap(r => r.request.body.events);
    }

    function clickLink(href: string): void {
        const a = document.createElement('a');
        a.href = href;
        a.addEventListener('click', e => e.preventDefault());
        fixture.appendChild(a);
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    beforeEach(() => {
        fixture = document.createElement('div');
        document.body.appendChild(fixture);
    });

    afterEach(() => {
        service?.ngOnDestroy();
        fixture.remove();
        for (const key of ['ga_client_id', 'ga_session_id', 'ga_last_activity', 'ga_session_number']) {
            localStorage.removeItem(key);
        }
    });

    it('sends nothing extra when enhancedMeasurement is not configured', async () => {
        configure({});
        await service.init();
        service.trackPageView('/search?q=shoes');
        clickLink('https://other.test/a.pdf');

        expect(sentEvents().map(e => e.name)).toEqual(['page_view']);
    });

    it('sends view_search_results after the page view, with session and page_location', async () => {
        configure({ siteUrl: 'https://www.mysite.test', enhancedMeasurement: { siteSearch: true } });
        await service.init();
        service.trackPageView('/search?q=shoes');

        const [pageView, search] = sentEvents();
        expect(pageView.name).toBe('page_view');
        expect(search.name).toBe('view_search_results');
        expect(search.params['search_term']).toBe('shoes');
        expect(search.params['page_location']).toBe('https://www.mysite.test/search?q=shoes');
        expect(search.params['session_id']).toBe(pageView.params['session_id']);
    });

    it('reports a search on the landing page view queued during init', async () => {
        configure({ enhancedMeasurement: { siteSearch: true } });
        const done = service.init();
        service.trackPageView('/?s=landing');
        await done;

        expect(sentEvents().map(e => e.name)).toEqual(['page_view', 'view_search_results']);
    });

    it('sends outbound clicks, treating the siteUrl host as internal', async () => {
        configure({ siteUrl: 'https://www.mysite.test', enhancedMeasurement: { outboundClicks: true } });
        await service.init();
        clickLink('https://www.mysite.test/about');
        clickLink('https://other.test/');

        const events = sentEvents();
        expect(events.map(e => e.name)).toEqual(['click']);
        expect(events[0].params['link_domain']).toBe('other.test');
        expect(events[0].params['outbound']).toBe(true);
    });

    it('stops listening on ngOnDestroy', async () => {
        configure({ enhancedMeasurement: { outboundClicks: true } });
        await service.init();
        service.ngOnDestroy();
        clickLink('https://other.test/');

        expect(sentEvents()).toEqual([]);
    });

    it('sends nothing while disabled at runtime', async () => {
        configure({ enhancedMeasurement: { outboundClicks: true } });
        await service.init();
        service.setEnabled(false);
        clickLink('https://other.test/');

        expect(sentEvents()).toEqual([]);
    });

    it('registers no listeners on the server', async () => {
        configure({ enhancedMeasurement: { outboundClicks: true, forms: true, scroll: true, siteSearch: true } }, 'server');
        await service.init();
        clickLink('https://other.test/');
        service.trackPageView('/search?q=x');

        expect(sentEvents()).toEqual([]);
    });
});

import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { NavigationEnd, provideRouter, Router, RouterOutlet, Routes, withEnabledBlockingInitialNavigation } from '@angular/router';
import {
    HttpInterceptorFn,
    HttpRequest,
    HttpResponse,
    provideHttpClient,
    withInterceptors
} from '@angular/common/http';
import { of } from 'rxjs';
import { ApplicationRef, APP_INITIALIZER, inject } from '@angular/core';
import { provideNgGa4 } from './ng-ga4.providers';
import { NgGa4Service } from './ng-ga4.service';

// Pins down that the FIRST page view is captured under both router configurations.
//
// The concern was concrete: the service subscribes to router events at the end of
// init(), after awaiting the client ID, session restore and device context. Under
// withEnabledBlockingInitialNavigation() — the configuration SSR setups conventionally
// use — the router's initial navigation is also an APP_INITIALIZER, so it looked
// possible for NavigationEnd to fire before the subscription existed. A router event
// missed that way is gone: the pendingCalls queue only catches manual track* calls
// made during init, never an event nobody was listening for.
//
// Measured, it does not happen. The ordering block below reads the sequence directly
// and gets ga4-subscribed before navigation-end, and handicapping init() by 50ms does
// not flip it — a genuine microtask race would lose that handicap every time, so the
// ordering is structural rather than lucky.
//
// These bootstrap a real application instead of injecting the service through TestBed,
// because APP_INITIALIZER ordering only exists on the real bootstrap path.

@Component({ standalone: true, selector: 'ga4-home', template: 'home' })
class HomeComponent {}

@Component({
    standalone: true,
    selector: 'ga4-race-root',
    imports: [RouterOutlet],
    template: '<router-outlet></router-outlet>'
})
class RootComponent {}

const routes: Routes = [{ path: '**', component: HomeComponent }];

describe('initial navigation', () => {
    let collected: HttpRequest<any>[];
    let host: HTMLElement;
    let appRef: ApplicationRef | null;

    const recorder: HttpInterceptorFn = (req, next) => {
        if (req.url.includes('mp/collect')) {
            collected.push(req);
            return of(new HttpResponse({ status: 204, body: '' }));
        }
        return next(req);
    };

    beforeEach(() => {
        collected = [];
        appRef = null;
        host = document.createElement('ga4-race-root');
        document.body.appendChild(host);
        localStorage.removeItem('ga_client_id');
        localStorage.removeItem('ga_session_id');
        localStorage.removeItem('ga_last_activity');
        localStorage.removeItem('ga_session_number');
    });

    afterEach(() => {
        appRef?.destroy();
        host.remove();
    });

    async function bootstrap(blocking: boolean): Promise<void> {
        appRef = await bootstrapApplication(RootComponent, {
            providers: [
                provideRouter(...(blocking ? [routes, withEnabledBlockingInitialNavigation()] : [routes]) as [Routes]),
                provideHttpClient(withInterceptors([recorder])),
                provideNgGa4({
                    measurementId: 'G-RACE',
                    apiSecret: 'secret',
                    enabled: true,
                    isExtension: false,
                    transport: 'xhr'
                })
            ]
        });
        await appRef.whenStable();
    }

    function pageViews(): HttpRequest<any>[] {
        return collected.filter(r => r.body?.events?.some((e: any) => e.name === 'page_view'));
    }

    // Control: the default (non-blocking) router runs its initial navigation from an
    // APP_BOOTSTRAP_LISTENER, which Angular runs only after every APP_INITIALIZER has
    // settled — so the subscription is always in place first.
    it('tracks the initial page view with the default non-blocking router', async () => {
        await bootstrap(false);

        expect(pageViews().length).toBe(1);
    });

    it('tracks the initial page view with blocking initial navigation', async () => {
        await bootstrap(true);

        expect(pageViews().length).toBe(1);
    });

    // The two above passing would not, on their own, prove the ordering is SAFE — only
    // that init() won a race on this machine. Handicapping init() by 50ms simulates a
    // slow device or a real getHighEntropyValues() round-trip; if the ordering were a
    // race, that handicap would lose it decisively.
    describe('with a slow init()', () => {
        function slowInitBy(ms: number): void {
            const original = (NgGa4Service.prototype as any).collectContext;
            spyOn<any>(NgGa4Service.prototype, 'collectContext').and.callFake(async function (this: any) {
                await new Promise(resolve => setTimeout(resolve, ms));
                return original.call(this);
            });
        }

        it('still tracks the initial page view when the router does not block', async () => {
            slowInitBy(50);

            await bootstrap(false);

            expect(pageViews().length).toBe(1);
        });

        it('still tracks the initial page view when the router blocks', async () => {
            slowInitBy(50);

            await bootstrap(true);

            expect(pageViews().length).toBe(1);
        });

        // Negative control. If the harness cannot observe a page view going missing,
        // every assertion above is vacuous. Severing the router subscription must
        // produce zero page views.
        it('records no page view when the router subscription never happens', async () => {
            spyOn(NgGa4Service.prototype, 'trackPageView');

            await bootstrap(true);

            expect(pageViews().length).toBe(0);
        });
    });

    // The decisive measurement. The outcome tests above infer the ordering from whether
    // a hit was sent; this reads the sequence directly, so a future change that reorders
    // bootstrap fails here with a legible diff rather than a mysterious missing event.
    describe('initializer ordering', () => {
        let order: string[];

        async function bootstrapWithProbe(blocking: boolean): Promise<void> {
            order = [];
            const originalInit = NgGa4Service.prototype.init;
            spyOn(NgGa4Service.prototype, 'init').and.callFake(async function (this: any) {
                await originalInit.call(this);
                order.push('ga4-subscribed');
            });

            appRef = await bootstrapApplication(RootComponent, {
                providers: [
                    // Registered first so it observes NavigationEnd no matter who else
                    // subscribes later.
                    {
                        provide: APP_INITIALIZER,
                        multi: true,
                        useFactory: () => {
                            const router = inject(Router);
                            router.events.subscribe(e => {
                                if (e instanceof NavigationEnd) {
                                    order.push('navigation-end');
                                }
                            });
                            return () => Promise.resolve();
                        }
                    },
                    provideRouter(...(blocking ? [routes, withEnabledBlockingInitialNavigation()] : [routes]) as [Routes]),
                    provideHttpClient(withInterceptors([recorder])),
                    provideNgGa4({
                        measurementId: 'G-RACE',
                        apiSecret: 'secret',
                        enabled: true,
                        isExtension: false,
                        transport: 'xhr'
                    })
                ]
            });
            await appRef.whenStable();
        }

        it('installs the subscription before NavigationEnd with a non-blocking router', async () => {
            await bootstrapWithProbe(false);

            expect(order).toEqual(['ga4-subscribed', 'navigation-end']);
        });

        it('installs the subscription before NavigationEnd with a blocking router', async () => {
            await bootstrapWithProbe(true);

            expect(order).toEqual(['ga4-subscribed', 'navigation-end']);
        });
    });
});

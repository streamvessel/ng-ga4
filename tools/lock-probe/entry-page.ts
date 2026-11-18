// Extension-page bundle: the seed, plus the real NgGa4Service from this branch's
// source, constructed directly (no injector) with stubs for everything that is
// not the client-ID path. Nothing is sent: no event is tracked, and the stub
// HttpClient would swallow it if one were.
import { Subject, of } from 'rxjs';
import { seedNgGa4ClientId } from '../../projects/ng-ga4/src/lib/seed-client-id';
import { NgGa4Service } from '../../projects/ng-ga4/src/lib/ng-ga4.service';

const httpStub = { post: () => of(null), get: () => of(null) };
const zoneStub = { run: (fn: () => unknown) => fn(), runOutsideAngular: (fn: () => unknown) => fn() };

async function service(): Promise<string> {
    const svc = new NgGa4Service(
        httpStub as any,
        { events: new Subject<unknown>().asObservable() } as any,
        zoneStub as any,
        { measurementId: 'G-PROBE', apiSecret: 'probe', enabled: true, isExtension: true, transport: 'xhr' } as any,
        'browser'
    );
    try {
        await svc.init();
        return (svc as any).clientId;
    } finally {
        svc.ngOnDestroy();
    }
}

(self as any).probeMint = { seed: () => seedNgGa4ClientId(), service };

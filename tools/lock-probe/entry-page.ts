// Page bundle: the seed and NgGa4Service, built directly with stubs. Sends nothing.
import { Subject, of } from 'rxjs';
import { seedNgGa4ClientId } from '../../projects/ng-ga4/src/lib/seed-client-id';
import { NgGa4Service } from '../../projects/ng-ga4/src/lib/ng-ga4.service';
import { CLIENT_ID_LOCK_NAME } from '../../projects/ng-ga4/src/lib/client-id-lock';

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

(self as any).probeMint = { lockName: CLIENT_ID_LOCK_NAME, seed: () => seedNgGa4ClientId(), service };

// Worker bundle: the seed only, since Angular runs in pages.
import { seedNgGa4ClientId } from '../../projects/ng-ga4/src/lib/seed-client-id';
import { CLIENT_ID_LOCK_NAME } from '../../projects/ng-ga4/src/lib/client-id-lock';

(self as any).probeMint = { lockName: CLIENT_ID_LOCK_NAME, seed: () => seedNgGa4ClientId() };

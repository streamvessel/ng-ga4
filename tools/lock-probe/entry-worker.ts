// Worker bundle: the seed only, since Angular runs in pages.
import { seedNgGa4ClientId } from '../../projects/ng-ga4/src/lib/seed-client-id';

(self as any).probeMint = { seed: () => seedNgGa4ClientId() };

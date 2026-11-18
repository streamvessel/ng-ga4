// Service-worker bundle: seedNgGa4ClientId() only. Angular runs in extension
// pages, not in the worker, so the seed is the realistic worker-side caller.
import { seedNgGa4ClientId } from '../../projects/ng-ga4/src/lib/seed-client-id';

(self as any).probeMint = { seed: () => seedNgGa4ClientId() };

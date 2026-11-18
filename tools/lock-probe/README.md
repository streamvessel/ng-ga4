# lock-probe

Manual check that an MV3 extension's service worker and pages share the client-ID Web Lock ([#51](https://github.com/streamvessel/ng-ga4/issues/51)). Karma can't test this: it runs a single page. Not part of CI or the npm package.

It builds this checkout's `seedNgGa4ClientId()` (worker) and `NgGa4Service` (pages) into a scratch extension, loads it into Chromium, checks that a lock held in one context blocks the others, and then races client-ID creation with the lock on and off.

## Running it

```bash
pnpm install                      # at the repository root
cd tools/lock-probe
npm install
npx playwright install chromium
node run.js                       # 200 races per arm by default
```

## Results

Chromium 153 (Playwright 1.63.0, headless), Linux, 2026-11-18. A lock held in any context (worker or page) was refused to every other one.

| Race (200 runs each) | Lock off: more than one ID | Lock on |
|---|---|---|
| seed (worker) vs seed (page) | 193 | 0 |
| seed (worker) vs service (page) | 187 | 0 |
| service (page) vs service (page) | 200 | 0 |
| seed (worker) vs service vs service | 198 | 0 |

Not covered: branded Chrome, other operating systems, a cold start from install, and the 3-second timeout (covered by unit tests). All callers start at once, so the lock-off counts are a worst case, not a real-world rate.

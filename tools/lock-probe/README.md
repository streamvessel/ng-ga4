# lock-probe

A manual test for the client-ID Web Lock ([#51](https://github.com/streamvessel/ng-ga4/issues/51)): do an MV3 extension's service worker and its pages really share `navigator.locks`, and does the lock stop them each creating a client ID?

The unit tests can't answer this. Karma runs one ordinary page, so it can check that the lock is requested, but not that a worker and a page wait for each other. This tool builds the library's own `seedNgGa4ClientId()` and `NgGa4Service` from this checkout into a scratch extension, loads it into Chromium, and races them.

It is not part of CI or the npm package. Run it when Chrome changes, or when the claim in [docs/chrome-extensions.md](../../projects/ng-ga4/docs/chrome-extensions.md#contexts-starting-together) is in doubt.

## Running it

```bash
pnpm install                      # at the repository root: provides Angular's linker and Babel
cd tools/lock-probe
npm install                       # esbuild and Playwright, pinned in package.json
npx playwright install chromium
node run.js                       # 200 races per arm; pass a number to change it
```

Takes a few minutes. The extension's bundles and the browser profile are created at run time and are gitignored.

## What it does

- **Bundles** `entry-worker.ts` (the seed only; Angular runs in pages, not the worker) and `entry-page.ts` (the seed and `NgGa4Service`) with esbuild. Angular's partial declarations are finished by Angular's own linker, as the Angular CLI does, because an extension page's CSP forbids the runtime compiler's `new Function`. The service is built with `new`, with stub `HttpClient`, `Router` and `NgZone`; it runs the real extension client-ID path, sends nothing, and is destroyed after each run.
- **Loads** the extension into Playwright's Chromium with one worker and two extension pages, plus a driver page that only coordinates.
- **Lock visibility.** One context holds `ng-ga4:client-id` while another asks for it with `ifAvailable`, for worker→page, page→worker and page→page.
- **Races.** For each arm: clear `chrome.storage`, then tell every caller to start at once over a `BroadcastChannel`, and compare the IDs each context ends up with and the one in storage. Each arm runs with the lock and with `navigator.locks` hidden in every context, which is the library's fallback.

## Results

Chromium 153.0.8010.12 (Playwright 1.63.0, headless), Linux, 2026-11-18, 200 runs per arm:

| Holder → asker | Granted to asker |
|---|---|
| worker → page | no |
| page → worker | no |
| page → page | no |

| Arm | Lock off: more than one ID | Lock on: more than one ID |
|---|---|---|
| seed (worker) vs seed (page) | 199/200 | 0/200 |
| seed (worker) vs service (page) | 200/200 | 0/200 |
| service (page) vs service (page) | 200/200 | 0/200 |
| seed (worker) vs service (page) vs service (page) | 200/200 | 0/200 |

Whenever there was more than one ID, some context also kept an ID that wasn't in storage. With the lock on, every context always ended with the stored ID. No run reported an error, and no page threw.

## What this does not show

- **Branded Chrome and other operating systems.** Only Playwright's Chromium on Linux was tested.
- **A real cold start.** All contexts were already running when told to race, not starting from an install.
- **A real-world rate.** The synchronised start makes the contexts overlap every time, so the lock-off counts are the worst case, not how often it happens to users.
- **The timeout path** (lock not granted within 3 seconds). The unit tests cover it.

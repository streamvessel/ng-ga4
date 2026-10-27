# ng-ga4

[![npm](https://img.shields.io/npm/v/@stream-vessel/ng-ga4)](https://www.npmjs.com/package/@stream-vessel/ng-ga4)
[![CI](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml/badge.svg)](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Google Analytics 4 for Angular over the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4) instead of `gtag.js`. It loads no remote script, so it works under a strict Content Security Policy and in Chrome extensions (Manifest V3). It takes care of the client ID, 30-minute sessions, page views from the Angular Router, real engagement time and consent, and stores its state in `chrome.storage` in an extension or `localStorage` on the web.

It was extracted from the [Stream Vessel](https://streamvessel.com) frontend and runs in production in its Chrome extension.

Without Google's script, GA4 learns less about each visit: it can't tell where visitors came from, and it shows no new users, engaged sessions, age or interests. [What you give up](projects/ng-ga4/README.md#what-you-give-up) has the full list. If your app can load `gtag.js`, use it; this library is for when it can't.

## Install

```bash
npm install @stream-vessel/ng-ga4
```

```typescript
import { NgGa4Module } from '@stream-vessel/ng-ga4';

@NgModule({
    imports: [
        NgGa4Module.forRoot({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false,
        }),
    ],
})
export class AppModule {}
```

**[Full documentation](projects/ng-ga4/README.md)**: standalone setup, every option, engagement time, `gtag.js` interop, consent, Chrome extensions and debug mode.

## Repository layout

An Angular CLI workspace whose only project is the library.

```
projects/ng-ga4/          # the library, the only published package
├── src/lib/              #   service, module, providers, config
├── src/public-api.ts     #   public API
├── README.md             #   the docs published to npm
├── LIMITATIONS.md        #   what the Measurement Protocol can't do, with measurements
└── ng-package.json       #   ng-packagr config (builds to dist/ng-ga4)
.github/workflows/        # ci.yml (lint, test, build), publish.yml (manual release)
```

## Development

Requires Node (see [`.nvmrc`](.nvmrc)) and pnpm via Corepack:

```bash
corepack enable
pnpm install

pnpm run build    # builds into dist/ng-ga4
pnpm test         # Karma/Jasmine, headless Chrome
pnpm run lint
```

CI runs those three, and all must pass before a pull request merges. To try an unreleased build in another app, see [Local development](projects/ng-ga4/README.md#local-development).

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and releases, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Supported Angular versions are under [Peer dependencies](projects/ng-ga4/README.md#peer-dependencies). Releases are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE)

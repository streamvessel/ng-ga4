# ng-ga4

[![npm](https://img.shields.io/npm/v/@stream-vessel/ng-ga4)](https://www.npmjs.com/package/@stream-vessel/ng-ga4)
[![CI](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml/badge.svg)](https://github.com/streamvessel/ng-ga4/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Google Analytics 4 for Angular, over the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4) instead of `gtag.js`. Because it never loads a remote script, it works where the usual GA4 snippet cannot: under a strict Content Security Policy, and inside Chrome extensions (Manifest V3), where remotely-hosted code is forbidden outright. It handles the parts you would otherwise write yourself — a persistent client ID, session tracking with a 30-minute timeout, and automatic page views from the Angular Router — and stores its state in `chrome.storage` when running as an extension, `localStorage` otherwise.

Extracted from the [Stream Vessel](https://streamvessel.com) frontend, where it runs in production.

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

**[→ Full documentation](projects/ng-ga4/README.md)** — standalone (`provideNgGa4`) setup, every config option, event and page-view tracking, Chrome extension notes, debug mode, and the API-secret security model.

## Repository layout

This is an Angular CLI workspace whose only project is the library.

```
projects/ng-ga4/          # the library — the only publishable artifact
├── src/lib/              #   service, module, providers, config, timezone→country map
├── src/public-api.ts     #   public API surface
├── README.md             #   the docs published to npm
└── ng-package.json       #   ng-packagr config (builds to dist/ng-ga4)
.github/workflows/        # ci.yml (lint + test + build), publish.yml (manual release)
```

## Development

Requires Node (see [`.nvmrc`](.nvmrc)) and pnpm via Corepack:

```bash
corepack enable
pnpm install

pnpm run build    # ng-packagr build into dist/ng-ga4
pnpm test         # Karma/Jasmine in headless Chrome
pnpm run lint
```

CI runs exactly those three, and all must pass before a pull request merges.

To try an unreleased change in a consuming app without publishing, see [Local development](projects/ng-ga4/README.md#local-development).

## Contributing

Bug reports, feature requests, and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing expectations, and the release process, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

Angular support: the peer range is permissive (`^16 || ^17 || ^18 || ^19`), but CI tests against Angular 18 only. Reports of breakage on other majors are welcome.

Released versions are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE)

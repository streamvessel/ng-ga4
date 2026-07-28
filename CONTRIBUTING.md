# Contributing

Thanks for your interest in improving `@stream-vessel/ng-ga4`.

## Setup

Requires Node (see `.nvmrc`) and pnpm via Corepack:

```bash
corepack enable
pnpm install
```

## Working on the library

```bash
pnpm run build    # ng-packagr build into dist/ng-ga4
pnpm test         # Karma/Jasmine in headless Chrome
pnpm run lint
```

All three must pass before a pull request can be merged; CI runs exactly these.

## Tests

Every behavioral change needs a test. The suite lives beside the source in
`projects/ng-ga4/src/lib/*.spec.ts` and runs against a real `TestBed` with
`HttpClientTestingModule`; Chrome extension storage is simulated by assigning to
`(window as any).chrome.storage`. Write the failing test first — a change that
cannot be observed by a test is usually a change that cannot be relied on.

## Pull requests

- One logical change per pull request.
- Update `CHANGELOG.md` under an `## [Unreleased]` heading.
- Public API changes must update `src/public-api.ts` and the README.

## Releases

Maintainers only: bump `version` in `projects/ng-ga4/package.json`, move the
`Unreleased` changelog entries under the new version heading, merge to `master`,
then run the **Publish** workflow from the Actions tab. It re-runs lint, tests,
and the build before publishing to npm and cutting a GitHub release.

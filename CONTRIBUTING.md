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

Maintainers only. Releases are cut from `master` by the **Publish** workflow; nothing
is published from a laptop.

1. Bump `version` in `projects/ng-ga4/package.json` following
   [semver](https://semver.org/spec/v2.0.0.html). The library is pre-1.0, so breaking
   changes go in the minor position.
2. In `CHANGELOG.md`, move the `## [Unreleased]` entries under a new
   `## [x.y.z] - YYYY-MM-DD` heading, and add the matching link reference at the bottom
   of the file. The publish job extracts that exact section as the GitHub release notes,
   so a missing or misspelled heading yields an empty release body.
3. Merge to `master` and wait for CI to pass.
4. Run **Actions → Publish → Run workflow** against `master`.

The workflow re-runs lint, unit tests, and the `ng-packagr` build before publishing,
then pushes a `vx.y.z` tag and creates the GitHub release. If the tag already exists it
fails before publishing anything — bump the version rather than re-dispatching.

### Authentication

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) via
GitHub OIDC. There is no `NPM_TOKEN` secret in this repository, and no maintainer needs
npm credentials to cut a release. The workflow declares `id-token: write` and upgrades
the npm CLI (trusted publishing requires npm ≥ 11.5.1, while the pinned Node ships
npm 10.x); npm then attaches build provenance automatically.

The trusted publisher is configured on npmjs.com under the package's
**Settings → Trusted Publisher**, bound to this repository and the `publish.yml`
workflow filename. Renaming that workflow file breaks publishing until the
configuration is updated to match.

Version `0.1.0` predates that setup and was published manually, so it is the one
release without a provenance attestation.

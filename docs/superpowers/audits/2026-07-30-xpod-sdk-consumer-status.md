# Xpod SDK Consumer Status - 2026-07-30

## Scope

Validated Xpod UI as a registry-style consumer of the Linx applet SDK packages from `/Users/ganlu/develop/.worktrees/linx-applet-packages` at commit `170cf6a6`.

Packages validated:

- `@undefineds.co/solid-sdk@0.1.0`
- `@undefineds.co/shared-ui@0.1.0`
- `@undefineds.co/extension-sdk@0.1.0`
- `@undefineds.co/ai-connection@0.1.0`

## Status

`ui/package.json` declares the four packages with semver ranges (`^0.1.0`) and no `file:`, `link:`, `workspace:`, or absolute source specifiers. The old `@linx` source alias was removed from both Vite and TypeScript config so UI code resolves package public ESM exports instead of Linx source.

The packages are not published to the npm registry yet. Because of that, `ui/bun.lock` was intentionally not updated: writing local tarball or local registry addresses into the committed lock would make the repository non-portable. After the four packages are published, run the normal UI install flow and commit the registry lockfile update.

## Verification

- RED: `bun run test:run tests/ui/packaged-sdk-consumer.test.ts` failed because `@undefineds.co/solid-sdk` was missing from `ui/package.json`.
- GREEN: `bun run test:run tests/ui/packaged-sdk-consumer.test.ts` passed. The test runs Linx `scripts/pack-applet-sdk.mjs`, installs the resulting tarballs into an isolated temp consumer, and verifies public ESM imports for `AppLayout`, `AuthBoundary`, `TwoPaneLayout`, `defineAppletLayout`, `createAiConnectionExtension`, and `SolidRuntimeProvider` through TypeScript and Vite.
- Build: `cd ui && npm install --no-save --legacy-peer-deps /Users/ganlu/develop/.worktrees/linx-applet-packages/.test-data/package-tarballs/*.tgz && bun run build:dashboard` passed. The temporary install was not saved to `ui/package.json`, and lockfile changes were discarded.
- Integration regression: `bun run test:integration` passed the lite phase (`19` test files, `101` tests passed, `5` skipped), then stopped in the full phase because Docker was not available (`Cannot connect to the Docker daemon at unix:///var/run/docker.sock`).

## Remaining Gate

Publish the four `0.1.0` packages to the registry, then update `ui/bun.lock` from registry resolution rather than local tarballs or a loopback registry. Re-run the full Docker-backed integration suite once Docker is available.

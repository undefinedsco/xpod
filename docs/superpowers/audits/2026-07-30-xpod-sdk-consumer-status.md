# Xpod SDK Consumer Status - 2026-07-30

## Scope

Tracked Xpod UI as a registry-style consumer of the applet SDK packages:

- `@undefineds.co/solid-sdk@^0.1.0`
- `@undefineds.co/shared-ui@^0.1.0`
- `@undefineds.co/extension-sdk@^0.1.0`
- `@undefineds.co/ai-connection@^0.1.0`

## Status

Task3 remains `blocked-by-registry`. `ui/package.json` now declares the four packages with semver ranges and no `file:`, `link:`, `workspace:`, or absolute source specifiers. The old `@linx` source alias was removed from both Vite and TypeScript config.

The normal UI install/build path still cannot complete because the four packages are not published to the npm registry. `ui/bun.lock` is intentionally unchanged until registry resolution is available; committing local tarball or loopback registry resolutions would make the repository non-portable.

## Verification

- RED: `bun run test:run tests/ui/packaged-sdk-consumer.test.ts` failed after adding a regression assertion because the test still hardcoded a sibling package checkout.
- GREEN unit: `bun run test:run tests/ui/packaged-sdk-consumer.test.ts` passed with `2` tests and `1` explicit skip. The default test path is hermetic: it checks the UI manifest, verifies no source alias or local package specifier remains, and skips package-consumer integration unless an explicit package source env is provided.
- Explicit tarball integration: `XPOD_APPLET_PACKAGE_TARBALL_DIR=/Users/ganlu/develop/.worktrees/linx-applet-packages/.test-data/package-tarballs bun run test:run tests/ui/packaged-sdk-consumer.test.ts` passed with `3` tests. The tarballs came from Linx commit `359ce84a` and were installed with normal npm peer resolution.
- Dashboard tarball build: `cd ui && npm install --no-save /Users/ganlu/develop/.worktrees/linx-applet-packages/.test-data/package-tarballs/*.tgz && bun run build:dashboard` passed. The temporary lockfile change was discarded.
- React instance check: `npm ls react react-dom @undefineds.co/solid-sdk @undefineds.co/shared-ui @undefineds.co/extension-sdk @undefineds.co/ai-connection --depth=2` showed the SDK packages deduped to Xpod UI's `react@19.2.3`; a filesystem scan found exactly one `node_modules/react`.
- SDK peer check: the installed tarballs declare `peerDependencies.react` as `^19.2.0` for all four SDK packages.
- Blocked build: `bun run build:ui` failed at `cd ui && bun install --frozen-lockfile` with registry `404` for the four `@undefineds.co/*` packages.

## Deferred Integration

The isolated consumer integration in `tests/ui/packaged-sdk-consumer.test.ts` only runs when either `XPOD_APPLET_PACKAGE_TARBALL_DIR` or `XPOD_APPLET_PACKAGE_REGISTRY_URL` is configured. It uses normal npm peer resolution and imports `@undefineds.co/shared-ui/theme.css`, `AppLayout`, `AuthBoundary`, `TwoPaneLayout`, `defineAppletLayout`, `createAiConnectionExtension`, and `SolidRuntimeProvider`.

Run normal `build:ui` and update `ui/bun.lock` after the packages are published to the registry.

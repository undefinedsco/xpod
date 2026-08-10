# Xpod Image Build Optimization Design

## Goal

Reduce Xpod Cloud image build and distribution time without removing product capabilities, then use the faster path for the QLever production cutover.

## Current constraints

- The current Docker build installs the full dependency graph twice and runs another install inside `ui`.
- Optional Agent SDKs contribute roughly 400–650 MB to the runtime dependency tree but are not required by the Cloud RDF/API server process.
- The current gz-to-Shenzhen TCR path uploaded a 1.6 GB image in about 2 hours 40 minutes.
- A gz-to-`ccr.ccs.tencentyun.com` probe proved authenticated push in 38 seconds and digest pull/run in 14 seconds.
- Cloud must keep QLever required. This work must not introduce a QLever fallback or a migration compatibility layer.

## Chosen architecture

The Dockerfile exposes two deliberate production targets built from one compilation result:

- `server` is the default Cloud/Local server image. Its production install omits optional and peer dependencies, so Claude, CodeBuddy and Zed ACP executors are not silently bundled into every Pod server. All root peer dependencies are optional Agent SDKs; this is verified against the manifest and installed tree.
- `agent-runner` is the execution-capable image. It keeps the complete production dependency graph and the same compiled application artifacts.

This is an artifact boundary, not an implicit runtime fallback. The Cloud deployment continues to run only the `server` target. Agent execution is deployed explicitly with the `agent-runner` artifact when its service boundary is enabled; the server never probes for a locally installed optional binary.

## Build pipeline

1. Copy only root and workspace manifests before dependency installation so source edits do not invalidate package download layers.
2. Mount Bun's package cache with BuildKit cache mounts.
3. Install development dependencies once for compilation.
4. Build TypeScript, Components.js metadata, workspace packages and UI from the root workspace install. `build:ui` must not run a second install.
5. Create the server production dependency tree with `bun install --production --omit optional --omit peer`.
6. Create the agent-runner production dependency tree with normal `bun install --production`.
7. Copy the compiled artifacts into the small Alpine runtime base. Keep `server` last so an unqualified `docker build` remains the server image.

## Registry and caching

The gz build job pushes the production cutover image directly to `ccr.ccs.tencentyun.com`. The immutable deployment input is still `repository@sha256`; mutable tags are convenience aliases only. Registry-backed BuildKit cache uses a separate cache reference and never becomes a deployable image.

The existing GHCR release path remains supported, but gains BuildKit GitHub Actions cache. Production cutover does not copy a completed multi-gigabyte image from gz through Shenzhen.

## Verification

- A static contract test proves the default target is `server`, the server omits optional dependencies, the runner retains them, and UI does not reinstall.
- `bun run build:ts`, Components.js metadata generation and the relevant test suite pass.
- Build the dependency/runtime targets separately before a full image build.
- Record image sizes and full build duration for both targets.
- Push the server image from gz to CCR, then pull it by digest in a clean Pod.
- Only after image verification continue the QLever conformance gate and production rollout.

## Non-goals

- No Agent RPC protocol or new Agent deployment is introduced in this cutover.
- No dependency manager replacement.
- No backward-compatible image alias, QLever fallback, or database migration path.

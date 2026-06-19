# Local Reachability Signaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the control-plane and managed-client MVP from `docs/local-reachability-signaling-spec.md`, then produce a minimal Harmony/OpenHarmony verification package if the local toolchain permits.

**Architecture:** Keep durable Pod/Solid identity unchanged and store route/session state in `cluster_node.metadata`, not in Pod RDF. Add focused route/session services under `src/edge/reachability`, expose API routes from the existing API server, and provide a small client-side route selector/canonical fetch adapter for Desktop/CLI/Native consumers. Real NAT traversal and relay data forwarding are out of this MVP; the API creates auditable short-lived control-plane sessions only.

**Tech Stack:** TypeScript, Bun, Vitest, existing `ApiServer`, `EdgeNodeRepository`, `AuthContext`, `cluster_node.metadata`, optional Harmony/OpenHarmony CLI (`hvigor`) if installed.

---

## File Structure

- Create `src/edge/reachability/types.ts`: shared `AccessRoute`, `RouteSet`, P2P session, relay session types.
- Create `src/edge/reachability/RouteSetBuilder.ts`: derives filtered route sets from node metadata/connectivity info.
- Create `src/edge/reachability/ReachabilitySessionService.ts`: creates short-lived P2P and relay session records under node metadata.
- Create `src/edge/reachability/ManagedRouteSelector.ts`: chooses candidate routes by priority and probe result.
- Create `src/edge/reachability/CanonicalFetch.ts`: creates a fetch wrapper that sends transport requests to `targetUrl` while preserving canonical headers.
- Create `src/edge/reachability/index.ts`: exports the reachability API surface.
- Create `src/api/handlers/ReachabilityHandler.ts`: exposes `GET /v1/signal/nodes/:nodeId/routes`, `POST /v1/signal/nodes/:nodeId/p2p-sessions`, and `POST /v1/signal/nodes/:nodeId/relay-sessions`.
- Modify `src/api/handlers/EdgeNodeSignalHandler.ts`: persist `reachability` and normalized `routes`/route candidates from heartbeats.
- Modify `src/api/container/routes.ts`: register reachability routes in shared API routes.
- Modify `src/index.ts`: export reachability utilities.
- Test `tests/edge/reachability/*.test.ts`: route derivation, session service, selector/canonical fetch behavior.
- Test `tests/api/handlers/ReachabilityHandler.test.ts`: API auth/filtering/session behavior.
- Modify `tests/api/RoutesRegistration.test.ts`: assert route registration.
- Optional create `harmony/minimal/`: minimal OpenHarmony sample package if no existing Harmony project exists.

---

## Task 1: RouteSet types and derivation

**Files:**
- Create: `src/edge/reachability/types.ts`
- Create: `src/edge/reachability/RouteSetBuilder.ts`
- Create: `src/edge/reachability/index.ts`
- Test: `tests/edge/reachability/RouteSetBuilder.test.ts`

- [x] **Step 1: Write failing route derivation tests**

Create tests that call `buildRouteSet` with a node record containing `publicUrl`, `subdomain`, `ipv4`, metadata `baseUrl`, `directCandidates`, `tunnel`, and metadata routes. Assert canonical URL stays stable, loopback/LAN routes are filtered from public browser output, public-direct and user-tunnel are included for public output, and managed output includes private routes.

Run: `bun test tests/edge/reachability/RouteSetBuilder.test.ts --run`
Expected: FAIL because files/functions do not exist.

- [x] **Step 2: Implement route types and builder**

Implement `AccessRouteKind`, `AccessRoute`, `RouteSet`, `RouteAudience`, and `buildRouteSet`. Use metadata only as runtime/control-plane state. Do not write Pod RDF. Normalize URL strings with `new URL()` and drop invalid routes.

- [x] **Step 3: Verify route derivation**

Run: `bun test tests/edge/reachability/RouteSetBuilder.test.ts --run`
Expected: PASS.

---

## Task 2: Heartbeat route metadata persistence

**Files:**
- Modify: `src/api/handlers/EdgeNodeSignalHandler.ts`
- Test: `tests/api/handlers/EdgeNodeSignalHandler.test.ts`

- [x] **Step 1: Write failing heartbeat tests**

Add tests showing heartbeats copy `reachability`, `routes`, and nested `metadata.routes` into persisted metadata and response. Assert body `nodeId` cannot override `auth.nodeId`.

Run: `bun test tests/api/handlers/EdgeNodeSignalHandler.test.ts --run`
Expected: FAIL because `reachability`/`routes` are not copied yet.

- [x] **Step 2: Implement metadata copy**

Add `copyIfPresent('reachability')`, `copyIfPresent('routes')`, and merge `payload.metadata` object under `metadata` without replacing top-level control metadata. Keep existing DNS/health behavior.

- [x] **Step 3: Verify heartbeat behavior**

Run: `bun test tests/api/handlers/EdgeNodeSignalHandler.test.ts --run`
Expected: PASS.

---

## Task 3: Routes API and session service

**Files:**
- Create: `src/edge/reachability/ReachabilitySessionService.ts`
- Create: `src/api/handlers/ReachabilityHandler.ts`
- Modify: `src/api/container/routes.ts`
- Test: `tests/api/handlers/ReachabilityHandler.test.ts`
- Test: `tests/api/RoutesRegistration.test.ts`

- [x] **Step 1: Write failing API tests**

Tests should capture registered handlers and assert:
- `GET /v1/signal/nodes/:nodeId/routes` returns public-filtered route set for unauthenticated/public route if marked public, or authorized route set for authenticated caller.
- Node auth can get its own managed route set but not another node.
- P2P session returns `sessionId`, `expiresAt`, `nodeCandidates`, `signalingUrl`, and persists metadata under `reachabilitySessions.p2p`.
- Relay session without `reason` or explicit authorization returns 400; valid relay returns TTL/limit/audit fields and persists metadata under `reachabilitySessions.relay`.

Run: `bun test tests/api/handlers/ReachabilityHandler.test.ts tests/api/RoutesRegistration.test.ts --run`
Expected: FAIL because handler/service are missing.

- [x] **Step 2: Implement API handler and session service**

Register:
- `GET /v1/signal/nodes/:nodeId/routes`
- `POST /v1/signal/nodes/:nodeId/p2p-sessions`
- `POST /v1/signal/nodes/:nodeId/relay-sessions`

Use node auth self-access for managed routes. Use Solid/service auth as same-account/authorized for now; do not expose private routes to unauthenticated calls. Session TTL defaults: P2P 5 minutes, relay 15 minutes. Relay requires `reason` and sets conservative default `bandwidthLimitBytes`.

- [x] **Step 3: Verify API behavior**

Run: `bun test tests/api/handlers/ReachabilityHandler.test.ts tests/api/RoutesRegistration.test.ts --run`
Expected: PASS.

---

## Task 4: Managed client route selection and canonical fetch

**Files:**
- Create: `src/edge/reachability/ManagedRouteSelector.ts`
- Create: `src/edge/reachability/CanonicalFetch.ts`
- Test: `tests/edge/reachability/ManagedRouteSelector.test.ts`
- Test: `tests/edge/reachability/CanonicalFetch.test.ts`

- [x] **Step 1: Write failing client tests**

Tests should assert selector orders by priority, skips routes requiring managed clients when `managedClient=false`, chooses the first route whose probe resolves true, and falls back to `null` when all fail. Canonical fetch test should assert a request for `https://canonical.example/alice/file` is sent to target route URL while `Host`/`x-xpod-canonical-url`/`x-xpod-canonical-origin` preserve canonical semantics.

Run: `bun test tests/edge/reachability/ManagedRouteSelector.test.ts tests/edge/reachability/CanonicalFetch.test.ts --run`
Expected: FAIL because files/functions are missing.

- [x] **Step 2: Implement selector and canonical fetch wrapper**

Implement dependency-injected `probe(route, signal)` and `fetch` functions for testability. Do not mutate original route arrays. Abort probes with timeout. Preserve path/query from canonical URL when rewriting to target URL.

- [x] **Step 3: Verify client utilities**

Run: `bun test tests/edge/reachability/ManagedRouteSelector.test.ts tests/edge/reachability/CanonicalFetch.test.ts --run`
Expected: PASS.

---

## Task 5: Verification and minimal Harmony package

**Files:**
- Optional Create: `harmony/minimal/*`
- Optional Create: `scripts/build-harmony-minimal.sh`
- Modify: `package.json` only if adding a local script is useful and no new dependency is introduced.

- [x] **Step 1: Run focused tests**

Run all tests added/modified in Tasks 1-4.
Expected: PASS.

- [x] **Step 2: Run typecheck and integration**

Run:
- `bun run build:ts`
- `bun run test:integration`
Expected: PASS.

- [x] **Step 3: Check Harmony toolchain**

Run:
- `command -v hvigor || command -v hvigorw || true`
- `command -v java || true`
- `find . -maxdepth 4 -name oh-package.json5 -o -name build-profile.json5 -o -name hvigorfile.ts`

If a buildable Harmony project/toolchain exists, build the smallest HAP. If not, create a minimal importable Harmony sample under `harmony/minimal/` plus README and script that clearly states DevEco/hvigor is required.

- [x] **Step 4: Package artifact**

Place the output under `.artifacts/harmony-minimal/`. If a `.hap` is produced, include it. If not, include a tarball of the minimal Harmony project and a `BUILD-REQUIRES-HVIGOR.txt` marker.

- [x] **Step 5: Final status**

Report commit hash, verification commands, artifact path, and whether the Harmony package is a real `.hap` or an importable source package.

---

## Execution Summary

Completed on 2026-06-19.

Implemented:
- Reachability route model, route derivation, managed route selector, and canonical fetch adapter.
- Signal heartbeat metadata ingestion for `reachability` and normalized route candidates.
- Shared API routes for `GET /v1/signal/nodes/:nodeId/routes`, `POST /v1/signal/nodes/:nodeId/p2p-sessions`, and `POST /v1/signal/nodes/:nodeId/relay-sessions`.
- Short-lived P2P/relay control-plane session persistence in `cluster_node.metadata.reachabilitySessions`.
- Minimal Harmony/OpenHarmony verifier source package under `harmony/minimal/`.
- PostgreSQL RDF write deadlock hardening discovered during integration verification: no transaction-local term DDL, no-op term conflict updates removed, and retry added for `40P01`/`40001` write failures.

Verification run:
- `./scripts/run-vitest-safe.sh --run tests/storage/rdf/PostgresRdfEngine.test.ts` — 11 passed.
- `bun run build:ts` — passed.
- `bun scripts/run-integration-full.ts tests/integration/MultiNodeCluster.integration.test.ts` — 2 passed.
- `./scripts/run-vitest-safe.sh --run tests/edge/reachability/RouteSetBuilder.test.ts tests/edge/reachability/ManagedRouteSelector.test.ts tests/edge/reachability/CanonicalFetch.test.ts tests/api/handlers/ReachabilityHandler.test.ts tests/api/handlers/EdgeNodeSignalHandler.test.ts tests/api/RoutesRegistration.test.ts tests/service/EdgeNodeSignalClient.test.ts tests/storage/rdf/PostgresRdfEngine.test.ts` — 45 passed.
- `bun run test:integration` — lite 87 passed / 2 skipped, full 40 passed.

Harmony packaging:
- Local `hvigor`/`hvigorw` was not installed, so no real `.hap` was produced locally.
- Source verifier package and marker are under `.artifacts/harmony-minimal/`.

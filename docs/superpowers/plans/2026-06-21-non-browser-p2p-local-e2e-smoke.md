# Non-Browser P2P Local E2E Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible local end-to-end smoke proving non-browser managed-client P2P flows through real signaling API routes, EdgeNodeAgent accept loop, raw TCP transport abstraction, and canonical Solid HTTP fetch semantics.

**Architecture:** Keep Cloudflare Tunnel and FRP/SakuraFRP untouched as independent `user-tunnel` fallback routes. The smoke starts an in-process signal API server, a local target HTTP server standing in for CSS/SP, a real `EdgeNodeAgent`, and a managed client fetch. For CI reliability, the smoke uses the existing injectable socket connector to join the two data-plane ends deterministically while still exercising the production signaling/client/agent orchestration.

**Tech Stack:** TypeScript, Bun, Vitest, existing `ApiServer`, `AuthMiddleware`, `EdgeNodeRepository`, `ServiceTokenRepository`, `EdgeNodeAgent`, and `runManagedClientP2PSmoke`.

---

## File Structure

- Create: `tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts`
  - Owns the reproducible in-process E2E smoke.
  - Uses actual HTTP API server and actual repository-backed signaling state.
  - Uses deterministic socket-pair injection only for the raw socket establishment boundary, so the test is stable on developer laptops and CI.
- Modify: `docs/local-phone-smoke.md`
  - Document the new automated local E2E smoke command and clarify that it does not replace external cross-NAT validation.
- Modify: `docs/local-reachability-signaling-spec.md`
  - Add the smoke to the implementation evidence section.

## Task 1: Repository-backed local P2P E2E smoke

**Files:**
- Create: `tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts`

- [x] **Step 1: Write the failing test**

Create a Vitest case named `runs route discovery, session exchange, node accept loop, and canonical fetch through local P2P signaling`. It should:

1. Create an in-memory identity DB.
2. Create an edge node token with `EdgeNodeRepository.createNode()`.
3. Create a service token with `ServiceTokenRepository.createToken()`.
4. Start `ApiServer` on a free local port with `MultiAuthenticator([ServiceTokenAuthenticator, NodeTokenAuthenticator])`.
5. Register `EdgeNodeSignalHandler` and `ReachabilityHandler`.
6. Start a local HTTP target server that responds to `/alice/local-p2p-e2e.txt`.
7. Start `EdgeNodeAgent` with P2P enabled and the signal API endpoint.
8. Wait until the heartbeat advertises the managed `p2p` route.
9. Run `runManagedClientP2PSmoke()` against the real API URL.
10. Assert selected route kind is `p2p`, response body came from the local target server, and canonical headers were injected.

Run:

```bash
./scripts/run-vitest-safe.sh --run tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts
```

Expected before the file exists: FAIL because the test file is missing / no matching test file.

- [x] **Step 2: Implement the test harness**

Add local helpers inside the test file only:

- `startJsonTargetServer()` for the target CSS/SP stand-in.
- `createSocketPair()` for deterministic raw socket handoff at the connector boundary.
- `waitForRoute()` to poll `GET /v1/signal/nodes/:nodeId/routes` until the heartbeat route appears.
- `buildTestAuth()` using real `ServiceTokenAuthenticator` and `NodeTokenAuthenticator`.

Do not modify production P2P code unless the test exposes a real bug.

- [x] **Step 3: Verify the local E2E smoke**

Run:

```bash
./scripts/run-vitest-safe.sh --run tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts
```

Expected: PASS.

## Task 2: Document smoke coverage and remaining external gap

**Files:**
- Modify: `docs/local-phone-smoke.md`
- Modify: `docs/local-reachability-signaling-spec.md`

- [x] **Step 1: Update docs**

Document:

- This smoke proves the non-browser orchestration path locally.
- It uses deterministic socket injection at the raw socket boundary for stability.
- It does not prove real cross-NAT TCP simultaneous open.
- Cloudflare Tunnel and FRP/SakuraFRP remain supported fallback routes and are not replaced by this P2P path.

- [x] **Step 2: Verify docs and code**

Run:

```bash
./scripts/run-vitest-safe.sh --run tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts tests/edge/reachability/ManagedClientP2PSmoke.test.ts tests/edge/EdgeNodeAgent.test.ts tests/api/handlers/ReachabilityHandler.test.ts
bun run build:ts
```

Expected: PASS.

## Self-Review

- Spec coverage: This plan advances local reproducible evidence for non-browser P2P but intentionally does not claim real cross-NAT completion.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: All named APIs already exist in `src/edge/reachability`, `src/edge/EdgeNodeAgent`, and API/auth modules.

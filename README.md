# Xpod: The Agent OS

Xpod is a **local-first Pod runtime for agents**.

It turns a Solid Pod into a runtime surface for data, identity, memory, sidecar capabilities, and AI APIs, all exposed through stable web interfaces.

Xpod is the runtime itself. Internally it is built from Community Solid Server plus an API layer behind one gateway, but those are implementation details, not separate product boundaries.

## What Xpod Provides

- **Pod-native runtime**: a Pod is not only storage, but the runtime envelope around identity, memory, tools, and sessions
- **Standard web surface**: HTTP, Solid, linked data, and stable URLs are the native interface
- **Local-first execution**: agents run near user-owned data instead of pushing everything into remote app silos
- **Multiple runtime shapes**: embed Xpod as a library, run it as a localhost service, or deploy it in the cloud
- **AI-ready services**: sidecar APIs and OpenAI-compatible APIs are available on the same runtime surface

## Runtime Shapes

### Embedded runtime

Start the full Xpod stack inside your own process.

This is the lightest mode for CI, integration tests, and app-embedded scenarios. On Unix, Xpod can run over a local socket, so no TCP port is required.

### Local daemon

Run Xpod as a localhost HTTP service for a desktop app, tray process, or multiple local apps on the same machine.

In this shape, Xpod is still the same runtime, just exposed over `127.0.0.1` so external processes can connect to it.

### Cloud deployment

Run Xpod as a hosted multi-user runtime with production dependencies such as PostgreSQL, Redis, and MinIO.

This shape is suitable for managed Pod hosting, quota enforcement, and cloud-edge coordination.

## Interfaces

### Pod and Solid surface

Xpod extends Community Solid Server and keeps Pod resources, WebID identity, and access control at the core.

### Sidecar APIs

Xpod exposes runtime capabilities alongside Pod resources through sidecar paths such as:

- `/-/sparql`
- `/-/vector`
- `/-/terminal` (planned)

### AI APIs

Xpod also exposes AI-facing APIs for apps and agents, including:

- `/v1/chat/completions`
- `/v1/responses`
- `/v1/messages`
- `/v1/models`
- `/v1/chatkit`

## Deployment Profiles

### `local`

Best for personal use, development, local agents, and app integration.

- SQLite + local disk
- no Redis or MinIO required
- good fit for embedded runtime and localhost daemon usage

### `cloud`

Best for hosted, multi-user, and production deployment.

- PostgreSQL + MinIO + Redis
- quota and usage infrastructure
- node coordination, DNS, and reachability support

See `docs/deployment-modes.md` for more detail.

## Quick Start

### Requirements

- Bun 1.3+
- Node.js 22+

If you are building from source, Bun is the main package manager and task runner. If you are only consuming the published npm package, Node is still enough at runtime.

### Install

```bash
bun install
bun run build
```

### ABI note

Xpod currently expects Node in `>=22 <27` for Node-based runtime and packaging paths. `.nvmrc` helps humans, but non-interactive shells, IDE tasks, AI runtimes, or CI subprocesses may still pick the wrong `node` from `PATH`.

Before local startup or integration tests, run:

```bash
nvm use
bun run check:abi
```

If you hit native module or `NODE_MODULE_VERSION` errors, reinstall dependencies under the same Node major:

```bash
nvm use
bun install --force
```

### Run locally

```bash
cp example.env .env.local
bun run local
```

Visit `http://localhost:3000/` after startup.

### Run in cloud mode

```bash
cp example.env .env.cloud
bun run cloud
```

## Hosted Preview and Support

- `xpod` Cloud 当前按 `hosted preview` 提供免费账号基线，不承诺正式订阅套餐
- 免费账号额度直接由 `XPOD_DEFAULT_*` 控制，不通过 `billing plan` 下发
- 当前支持方式是手工捐款与 supporter 认领，不是自动开通的资源升级档
- supporter 记录只表达支持关系与非资源权益，不会自动提高存储、带宽或模型额度
- 对外口径与支持说明可放在 `https://undefineds.co/zh-CN/support/` 与 `https://undefineds.co/en/support/`

## Library Mode

If you want the full Xpod stack inside your own process, import it as a library instead of spawning the CLI.

### In-process runtime without a TCP port

```ts
import { startXpodRuntime } from '@undefineds.co/xpod/runtime';

const runtime = await startXpodRuntime({
  mode: 'local',
  open: true,
  transport: 'socket',
});

const res = await runtime.fetch('/service/status');
console.log(await res.json());

await runtime.stop();
```

On Unix, `transport: 'socket'` keeps the full Xpod runtime in-process without binding a TCP port. This is the preferred shape for CI and integration tests.

Use `open`, `authMode`, `apiOpen`, and related runtime options to tune authentication behavior for tests or embedded app flows.

### No-auth test helper

```ts
import { startNoAuthXpod } from '@undefineds.co/xpod/test-utils';

const xpod = await startNoAuthXpod();
console.log(xpod.baseUrl);
await xpod.stop();
```

This helper is the lightest downstream path for integration tests that only need an open local stack.

### Using Xpod from a downstream project

Install Xpod as a dev dependency:

```bash
bun add -d @undefineds.co/xpod
```

Recommended entry points:

- `@undefineds.co/xpod/runtime` — full runtime API (`startXpodRuntime`)
- `@undefineds.co/xpod/test-utils` — lightest no-auth helper (`startNoAuthXpod`)

A minimal `vitest` example:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNoAuthXpod } from '@undefineds.co/xpod/test-utils';

let xpod: Awaited<ReturnType<typeof startNoAuthXpod>>;

beforeAll(async() => {
  xpod = await startNoAuthXpod();
}, 60_000);

afterAll(async() => {
  await xpod?.stop();
});

describe('xpod integration', () => {
  it('starts in-process', async() => {
    const response = await fetch(new URL('/service/status', xpod.baseUrl));
    expect(response.ok).toBe(true);
  });
});
```

Keep Docker/full integration tests on real services. Use library mode for lite and app-embedded test paths.

### Localhost gateway for external apps

```ts
import { startXpodRuntime } from '@undefineds.co/xpod/runtime';

const runtime = await startXpodRuntime({
  mode: 'local',
  transport: 'socket',
  bindHost: '127.0.0.1',
  baseUrl: 'http://127.0.0.1:5710/',
  gatewayPort: 5710,
});

console.log(runtime.baseUrl); // http://127.0.0.1:5710/
```

Use this shape when Xpod needs to behave as a shared local service. External apps connect over HTTP to the localhost gateway, while internal CSS/API traffic stays on Unix sockets.

If Unix sockets are unavailable, switch to `transport: 'port'` to run the internal services on TCP ports too.

## Testing

```bash
bun run test:integration:lite
bun run test:integration:full
bun run test:bun:runtime
```

- `test:integration:lite` starts Xpod in-process and runs the light integration path
- `test:integration:full` keeps the real service stack for PostgreSQL / Redis / MinIO dependent paths
- `test:bun:runtime` is the Bun runtime smoke gate

## Single-File Packaging

### Node launcher

Build a self-extracting launcher:

```bash
bun run build:single:standalone
```

Output file:

- `.artifacts/xpod-single.cjs`

Run it directly with Node:

```bash
node .artifacts/xpod-single.cjs --mode local
```

### Bun native binary

Build the Bun single-file binary:

```bash
bun run build:single:bun
```

Output file:

- `dist/xpod-bun`

Run it directly:

```bash
dist/xpod-bun --mode local --port 5710
```

On supported Unix platforms, `npm install @undefineds.co/xpod` can also resolve a matching optional platform package for the native `xpod` binary.

## Architecture at a Glance

Xpod is one runtime with a unified gateway and several internal planes:

- **Pod / data plane**: Pod resources, RDF storage, access control, and standard Solid handling
- **API / control plane**: AI-facing APIs, admin APIs, sidecar capabilities, and coordination services
- **Agent runtime plane**: sessions, tasks, tool access, and long-running agent behavior near the Pod

In implementation terms, CSS and the API service are internal parts of Xpod's runtime.

## Typical Use Cases

- **Personal Agent OS**: run your own AI-native Pod locally with your data, memory, and tools
- **Desktop or local app backend**: expose one localhost runtime that multiple apps can share
- **Backend for AI-native Solid apps**: combine Pod-native data, identity, and AI services in one runtime
- **Managed Pod platform**: host many users on shared infrastructure while preserving Pod isolation

## Documentation

- `docs/deployment-modes.md` — local vs cloud deployment
- `docs/architecture.md` — system architecture overview
- `docs/COMPONENTS.md` — component overrides and architecture extensions
- `docs/sidecar-api.md` — sidecar API patterns

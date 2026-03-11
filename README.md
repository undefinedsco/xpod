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

- Node.js 22
- Yarn 1.x

### Install

```bash
nvm use
yarn install
yarn build
```

### ABI note

Xpod currently targets Node 22 (`>=22 <23`). `.nvmrc` helps humans, but non-interactive shells, IDE tasks, AI runtimes, or CI subprocesses may still pick the wrong `node` from `PATH`.

Before local startup or integration tests, run:

```bash
nvm use
yarn check:abi
```

If you hit `better-sqlite3` or `NODE_MODULE_VERSION` errors, reinstall native dependencies under the same Node major:

```bash
nvm use
yarn install --force --ignore-engines
```

### Run locally

```bash
cp example.env .env.local
yarn local
```

Visit `http://localhost:3000/` after startup.

### Run in cloud mode

```bash
cp example.env .env.cloud
yarn cloud
```

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

Use `open`, `authMode`, and `apiOpen` to tune authentication behavior for tests or embedded app flows.

### Localhost runtime service for external apps

```ts
import { startXpodRuntime } from '@undefineds.co/xpod/runtime';

const runtime = await startXpodRuntime({
  mode: 'local',
  transport: 'port',
  bindHost: '127.0.0.1',
  baseUrl: 'http://127.0.0.1:5710/',
  gatewayPort: 5710,
});

console.log(runtime.baseUrl); // http://127.0.0.1:5710/
```

Use this shape when Xpod needs to behave as a shared local service. External apps should connect over HTTP to the localhost gateway, not to an internal socket.

Useful package entry points:

- `@undefineds.co/xpod`
- `@undefineds.co/xpod/runtime`
- `@undefineds.co/xpod/test-utils`

## Single-File Packaging

Build a self-extracting launcher:

```bash
yarn build:single:standalone
```

Output file:

- `dist/xpod-single.cjs`

Run it directly with Node:

```bash
node dist/xpod-single.cjs --mode local
```

On first start, it extracts runtime files to cache (default `~/.xpod/single-file-cache/`; override with `XPOD_SINGLE_CACHE_DIR`) and reuses that cache on subsequent launches.

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
- `docs/desktop-roadmap.md` — local and desktop-oriented evolution ideas

## License

MIT

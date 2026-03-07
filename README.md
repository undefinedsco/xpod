# Xpod: The Agent OS

**Xpod is the Semantic File System for AI Agents.**

As explored in recent research (Manus, Claude Code, AGFS), the most effective interface for Agents is not a complex set of APIs, but a **File System**.

Following the Unix philosophy of *"Everything is a file"*, Xpod abstracts the complex world into a unified resource hierarchy accessible via standard protocols (HTTP/Solid).

This is achieved through **Pods** (Personal Online Data stores)—portable web containers that act like a **"USB Drive for your Agent"**. A Pod encapsulates an Agent's entire digital life: its identity, memory, and skills.

**Xpod comes with a built-in Base Agent** that runs natively within this environment, ready to navigate, read, and execute Skills out of the box.

## Installation

Ensure you have [Node.js](https://nodejs.org/) and [Yarn](https://yarnpkg.com/) installed:

```bash
yarn install
yarn build
```


## Single-File Build & Local npm Release

- Build a single-file CLI entry (Node 22 target):
  ```bash
  yarn build:single
  ```
  Output: `dist/xpod.single.cjs` (also exposed as `xpod-single` in `bin`).

- Create a local-tag npm publish (auto bumps to `-local.<timestamp>`):
  ```bash
  yarn publish:local
  ```

- Dry-run publish (no real upload, package.json auto-restored):
  ```bash
  yarn publish:local:dry
  ```

- Publish stable release (`latest` tag by default):
  ```bash
  yarn publish:release
  ```

- Dry-run stable release publish:
  ```bash
  yarn publish:release:dry
  ```

## Quick Start

| Mode | Command | Description |
| --- | --- | --- |
| Local | `yarn local` | SQLite + local disk, no external dependencies |
| Cloud | `yarn cloud` | PostgreSQL + MinIO + Redis, production ready |
| Dev | `yarn dev` | Alias for local mode |

Configure environment:
```bash
cp example.env .env.local     # For local/dev
cp example.env .env.cloud     # For cloud/production
```

Visit [http://localhost:3000/](http://localhost:3000/) after startup.

See [docs/deployment-modes.md](docs/deployment-modes.md) for detailed profile comparison and cloud-edge coordination.

## Library Mode for Tests

If you want to start the full Xpod stack inside your test process, you can import it as a library instead of spawning the CLI.

```ts
import { startXpodRuntime } from '@undefineds.co/xpod';

const runtime = await startXpodRuntime({
  mode: 'local',
  open: true,
  transport: 'socket',
});

const res = await runtime.fetch('/service/status');
console.log(await res.json());

await runtime.stop();
```

For the lightest test setup, use the test helper export:

```ts
import { startNoAuthXpod } from '@undefineds.co/xpod/test-utils';

const xpod = await startNoAuthXpod();
console.log(xpod.baseUrl);
await xpod.stop();
```

Notes:
- In socket mode, the logical base URL is `http://localhost/`, but real traffic goes through a Unix socket.
- This mode is ideal for CI and integration tests that should avoid external port conflicts.
- Docker/cluster integration tests should still use real service startup.

### Using Xpod from a downstream project

Install Xpod as a dev dependency in your test project:

```bash
yarn add -D @undefineds.co/xpod
```

Recommended entry points:
- `@undefineds.co/xpod` — full runtime API (`startXpodRuntime`)
- `@undefineds.co/xpod/test-utils` — lightest no-auth helper (`startNoAuthXpod`)
- `@undefineds.co/xpod/runtime` — runtime-only subpath if you want to avoid the broader root entry

A minimal `vitest` example in a downstream repo:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNoAuthXpod } from '@undefineds.co/xpod/test-utils';

let xpod: Awaited<ReturnType<typeof startNoAuthXpod>>;

afterAll(async() => {
  await xpod?.stop();
});

beforeAll(async() => {
  xpod = await startNoAuthXpod();
}, 60_000);

describe('xpod integration', () => {
  it('starts in-process', async() => {
    const response = await fetch(new URL('/service/status', xpod.baseUrl));
    expect(response.ok).toBe(true);
  });
});
```

If you need more control in a downstream repo, use `startXpodRuntime` directly:

```ts
import { startXpodRuntime } from '@undefineds.co/xpod';

const runtime = await startXpodRuntime({
  mode: 'local',
  open: true,
  transport: 'socket',
  runtimeRoot: './.test-data/xpod-runtime',
});

// use runtime.baseUrl / runtime.fetch / runtime.sockets here
await runtime.stop();
```

Typical downstream use cases:
- Use `startNoAuthXpod()` for CI-friendly integration tests that only need an open local stack.
- Use `startXpodRuntime()` when you need auth mode, custom storage paths, or explicit runtime options.
- Keep Docker/cluster tests on real services; use library mode for local/lite test paths.

## Single-File Packaging

Build a self-extracting single-file launcher:

```bash
yarn build:single:standalone
```

Output file: `dist/xpod-single.cjs`

Run it directly (requires Node.js):

```bash
node dist/xpod-single.cjs --mode local
```

On first start, it extracts runtime files to cache (default `~/.xpod/single-file-cache/`; override with `XPOD_SINGLE_CACHE_DIR`) and reuses that cache on subsequent launches.

## Deployment Strategies

Xpod supports two primary deployment models, functioning like a Personal OS or a Multi-User Mainframe:

1.  **Self-Hosted (Personal OS)**: Run Xpod on your laptop (`yarn local`) or private server. You have exclusive control over the hardware and kernel. Ideal for personal agents and maximum privacy.
2.  **Managed Hosting (Multi-User OS)**: Deploy Xpod as a shared server (`yarn cloud`) hosting thousands of Pods. Similar to a Unix mainframe with many users (`/home/alice`, `/home/bob`), Xpod strictly enforces isolation between Pods using WebIDs and ACLs. Users share infrastructure but retain ownership of their data and can migrate their Pods to other instances.

## The "Everything is a Resource" Architecture

Xpod **leverages** the **W3C Solid Protocol** to construct a comprehensive **Runtime Environment for Agents**:

### 1. File System as Memory
Instead of opaque bytes, Xpod's file system is **Semantic**.
- **Memory vs Context**: The entire Pod is your **Memory** (Total Knowledge). When an Agent enters a folder (e.g., `/projects/xpod/`), that folder becomes its **Context**. Navigating the file system naturally switches the Agent's attention scope.
- **Universal Context**: In traditional systems, data is locked in proprietary formats. In Xpod, all data (Emails, Tasks, Notes) is stored in **RDF**—a universal data model. This allows Agents to understand and link data from any source without custom parsers.
- **Universal Interface**: One protocol to rule them all. Agents use standard HTTP methods (`GET`, `PUT`, `DELETE`) to access everything—Memory, Files, Skills, and I/O. This drastically simplifies Agent design, as they don't need to learn thousands of different APIs.
- **Smarter Agents**: Because Context is universally understood and accessible via a single protocol, Agents have a holistic view of your life and can connect dots between different domains effortlessly, leading to unprecedented intelligence.

### 2. Identity as Path (`/profile/card#me`)
Identity is not a database row, but a **URI**.
- **WebID**: Every Agent has a globally unique ID (e.g., `https://pod.xpod.io/agent-alice/profile#me`).
- **Access Control (ACL)**: Permissions are managed like file system attributes (Read/Write/Control), but applied to web resources.

### 3. Virtual Resources (Dynamic Context)
Not all resources are static files. Xpod supports **Virtual Resources** where the path is a key to a dynamic strategy.
- **Implicit Graphs as Folders**: A path like `/threads/{id}/` or `/-/search?q=Entity` may not exist on disk. instead, it dynamically aggregates related messages via graph or vector retrieval, presenting them as a folder.
- **API as File**: External capabilities are mapped to paths. Reading `/weather/current` triggers an API call; writing to `/inbox/` triggers a message delivery pipeline.
- **Benefit**: Agents interact with complex, dynamic systems using the same simple file operations (`GET`/`PUT`) used for static memory.

### 4. Security as Attributes (`chmod`)
Xpod implements a fine-grained permission model tailored for Agents.
- **WAC/ACP**: Access Control Lists (ACLs) determine which Agent (WebID) can Read, Write, or Append to any resource.
- **Trust Chains**: Agents can form groups and delegate permissions, enabling secure multi-agent collaboration.

### 5. Terminal & Skills (`/bin/*`)
Xpod provides the runtime interfaces for Agent execution and interaction.
- **`/-/terminal`** (Roadmap): A resource-based console. Agents listen to `/agents/{id}/stdin` and write to `/agents/{id}/stdout`, enabling interaction purely through file operations.
- **Skills (Composable Capabilities)**: Xpod is the ideal runtime for Skills, enabling them to be:
    - **Composable**: Skills interact via the standardized file system. The output of one Agent (an RDF graph or file) is immediately available as input for another.
    - **Portable**: Built on Web Standards (JS/WASM + Markdown), Skills run consistently across Local, Server, or Edge Xpod instances.
    - **Efficient**: Xpod's RDF indexing allows Skills to retrieve precise facts without loading massive files into the Context Window.
    - **Powerful**: Unlike cloud agents trapped in sandboxes, Xpod Skills have **Root Access** to your digital life. They can access your full history, local files, and private devices, acting as a true Digital Butler rather than just a Chatbot.

### 6. Network & Federation (Cloud-Edge Architecture)
Xpod introduces a robust distributed architecture on top of standard Solid protocols.
- **Control Plane (The Cloud)**: The Xpod Server acts as a coordinator, providing DNS, TLS certificates, and Tunneling services. It ensures your Agent is discoverable and reachable from the global internet.
- **Data Plane (The Edge)**: Your Local Xpod holds the actual data and runs the Agents. It connects to the Cloud for reachability but executes Skills locally, ensuring data never leaves your physical control.

### 7. Dual-Process Architecture (CSS + API Server)

Xpod runs as two cooperating processes behind a single gateway:

| Process | Port | Responsibility |
|---------|------|----------------|
| **CSS** (Solid Server) | 3000 | LDP resource access, OIDC auth, SPARQL, WebSocket notifications |
| **API Server** | 3001 | Node management, heartbeat/DNS sync, quota, API Keys, AI chat |

- **CSS** handles everything related to the Solid protocol — it's the kernel of the Pod file system.
- **API Server** handles management APIs that don't belong in the Solid request chain.
- Both share the same PostgreSQL database (server mode) or SQLite (local mode).

**Auth methods**: Solid Token (DPoP/Bearer), API Key (`sk-*`), Node Token (`XpodNode nodeId:token`).

**API Server routes**:

| Route | Description | Mode |
|-------|-------------|------|
| `POST /v1/signal` | Edge node heartbeat → health check → DNS sync | Shared |
| `/v1/nodes/*` | Node CRUD | Shared |
| `/v1/keys/*` | API Key management | Shared |
| `/v1/chat/completions` | OpenAI-compatible chat (SSE streaming) | Shared |
| `/v1/responses` | OpenAI Responses API | Shared |
| `/v1/messages` | Anthropic/OpenAI Threads compatible | Shared |
| `/v1/models` | List available models | Shared |
| `POST /v1/chatkit` | ChatKit protocol endpoint (streaming) | Shared |
| `/v1/chatkit/threads/*` | ChatKit REST API (threads CRUD, items) | Shared |
| `/v1/subdomains/*` | Subdomain allocation | Cloud |
| `/v1/ddns/*` | Dynamic DNS management | Cloud |
| `/v1/webid-profile/*` | WebID Profile hosting | Cloud |
| `/provision/nodes` | SP registration | Cloud |
| `/provision/pods` | Pod creation (SP callback) | Local |
| `/admin/*` | Local config & restart | Local |

Key components:
- `EdgeNodeSignalHandler` (API Server) — receives heartbeats, triggers health checks and DNS synchronization
- `EdgeNodeSignalClient` (local/edge) — sends periodic heartbeats with system metrics, network info, and tunnel status

## Privacy & Compliance (GDPR)

Xpod is designed for the post-GDPR world, where **Data Sovereignty** is paramount.

- **Data Ownership**: Unlike SaaS platforms where data is locked in silos, Xpod stores data in **User-Owned Pods**. You physically possess your data (on your disk or your chosen server).
- **Code Moves to Data**: Computation happens **locally** next to the data. This "Local-First" architecture minimizes data leakage and cross-border transfer risks.
- **Granular Consent**: WAC/ACP Access Control Lists allow users to grant Agents access only to specific resources (e.g., "Read `/photos/` but not `/documents/`").
- **Right to be Forgotten**: Deleting a resource in Xpod is a true physical deletion, ensuring compliance with erasure requests.

## Roadmap

- [x] DB-Based Identity Provider
- [x] Fine-Grained Pod Capacity Management
- [x] SPARQL 1.1 via LDP (sparql-update)
- [x] Sidecar API: SPARQL (`/-/sparql`)
- [x] Sidecar API: Vector (`/-/vector`)
- [x] Cloud-Edge Cluster Architecture
- [x] API Server (dual-process architecture, separated from CSS)
- [x] Multi-Auth: Solid Token / API Key / Node Token
- [x] Edge Node Heartbeat + Health Check + DNS Sync
- [x] SP Provision & Pod Management
- [x] AI API: Chat Completions, Responses, Messages, Models (OpenAI-compatible, SSE streaming)
- [x] ChatKit API (conversation management)
- [x] Subdomain & DDNS Management
- [ ] Sidecar API: Terminal (`/-/terminal`)
- [ ] Rate Limiting
- [ ] Attribute-Based Access Control (ABAC)
- [ ] Feature Store (Federated Learning)

## Documentation

- [docs/COMPONENTS.md](docs/COMPONENTS.md) - Components.js reference and configuration patterns
- [docs/api-service-design.md](docs/api-service-design.md) - API Server architecture, routes, and auth design
- [docs/deployment-modes.md](docs/deployment-modes.md) - Deployment profiles (local, cloud)
- [docs/admin-guide.md](docs/admin-guide.md) - Admin initialization, roles, and reserved names
- [docs/edge-cluster-architecture.md](docs/edge-cluster-architecture.md) - Cloud-edge coordination and routing
- [docs/edge-node-deployment-modes.md](docs/edge-node-deployment-modes.md) - Edge node deployment scenarios
- [docs/sidecar-api.md](docs/sidecar-api.md) - Sidecar API pattern (`/-/{service}`)
- [docs/sparql-support.md](docs/sparql-support.md) - SPARQL 1.1 support details
- [docs/vector-api-server-guide.md](docs/vector-api-server-guide.md) - Vector search API guide

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) to understand how to contribute to the project.

## License

Xpod is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

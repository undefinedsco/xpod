# Deployment Modes

## Profile Comparison

| Capability | `local` | `server` |
| --- | --- | --- |
| Data & Dependencies | SQLite + local disk; no Redis/MinIO dependency (optional) | PostgreSQL + MinIO + Redis, supports horizontal scaling |
| Quota Strategy | `NoopQuotaService`, no validation by default | `PerAccountQuotaStrategy`, configurable default/custom limits |
| Cloud-Edge Coordination | Disabled, Agent can be customized | Built-in `EdgeNodeSignal`, DNS-01, usage tracking; enable via env |
| Tunnel Fallback | Disabled | Configurable `XPOD_FRP_*` + Agent `frp` auto-manages `frpc` |
| Certificate Automation | Manual config or desktop client trigger | ACME + DNS-01 auto-renewal, distributed to nodes |
| Bandwidth Quota | No tracking, no throttling | `identity_account_usage` / `identity_pod_usage` tables track `ingress_bytes` / `egress_bytes`; `UsageTrackingStore` + `SubgraphSparqlHttpHandler` collect data; default 10 MiB/s (configurable in `config/extensions.server.json`) |
| Typical Scenarios | Personal dev, testing, desktop client | Production deployment, cloud-edge cluster with local nodes |

> Cloud-edge coordination: Set Signal/DNS/ACME/FRP variables in server environment, run `EdgeNodeAgent` on local nodes (see [edge-node-agent.md](edge-node-agent.md)) for dynamic DNS, certificates, and tunnel orchestration.

## Local Mode: Three Deployment Patterns

### 1. Self-Managed HTTPS (Full Self-Hosting)

Node manages its own certificates and 443 listener. `EdgeNodeAgent` doesn't participate in certificate/tunnel logic. Suitable for users familiar with TLS who have fixed public IPs.

### 2. Direct Connection + Auto Certificates

Node can expose port 443 but doesn't want to manually run ACME. Use `EdgeNodeAgent`'s `acme` config to request DNS-01 from server, then deploy certificates locally.

### 3. No Port 443 Available

Use FRP tunnel fallback. Agent auto-manages `frpc` based on server-provided config. Client access is forwarded through server's frps. Suitable for home broadband, mobile networks, or scenarios where port exposure is difficult.

> Desktop client will integrate these capabilities (certificate requests, tunnel toggle, log viewing). This repository provides the underlying interfaces and example scripts.

## Coordination with Server

### Local-1 (Self-Managed HTTPS) ↔ Server

Server only provides account management and heartbeat registration. Usage stats can be self-managed by node or aggregated to server as needed. DNS points to node's own HTTPS endpoint. Other cloud-edge features (ACME, tunnels) can remain disabled.

### Local-2 (Direct + Auto Cert) ↔ Server

Server handles DNS-01 challenge coordination and heartbeat registration. Node renews certificates locally and maintains its own usage data. DNS still points to node's public IP.

### Local-3 (Tunnel Fallback) ↔ Server

Server must enable DNS, FRP components. Responsible for assigning tunnel endpoints, distributing `frpc` config, and auto-falling back to tunnel traffic when direct connection unavailable.

A single Server instance can manage multiple Local node types - just set the appropriate environment variables/Agent config for each node type.

## Cluster Mode

Cluster mode separates the control plane and edge nodes for cloud-edge architecture.

### Cluster Server (Control Plane)

```bash
yarn cluster:server    # or: yarn cluster
```

- Reuses server profile but reads `.env.cluster`
- Runs the control plane for cloud-edge cluster
- Manages edge node registration, DNS coordination, certificate distribution

### Cluster Local (Edge Node)

```bash
yarn cluster:local
```

- Reads `.env.cluster.local`
- Connects to control plane as an edge node
- Required environment variables:
  ```bash
  CSS_EDGE_NODES_ENABLED=true
  CSS_NODE_ID=my-edge-node-001
  CSS_NODE_TOKEN=<token-from-control-plane>
  CSS_SIGNAL_ENDPOINT=https://control-plane.example.com/api/signal
  ```

### Cluster Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Control Plane                       │
│              (yarn cluster:server)                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │ Signal  │  │  DNS    │  │  ACME   │             │
│  │ Server  │  │ Coord   │  │ Coord   │             │
│  └─────────┘  └─────────┘  └─────────┘             │
└─────────────────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌───────────┐  ┌───────────┐  ┌───────────┐
│ Edge Node │  │ Edge Node │  │ Edge Node │
│  (local)  │  │  (local)  │  │  (local)  │
└───────────┘  └───────────┘  └───────────┘
```

### Environment Files

| File | Purpose |
| --- | --- |
| `.env.cluster` | Control plane configuration |
| `.env.cluster.local` | Edge node configuration |

## Environment Variables

Copy environment templates for different modes:

```bash
cp example.env .env.local          # Local / Dev
cp example.env .env.server         # Server / Production
cp example.env .env.cluster        # Cluster control plane
cp example.env .env.cluster.local  # Cluster edge node
```

Edit the appropriate file based on your deployment mode. Root `.env` can be kept for legacy script compatibility.

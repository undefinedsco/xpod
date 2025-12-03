# Xpod

Xpod is an extended [Community Solid Server (CSS)](https://github.com/solid/community-server), offering rich-feature, production-level Solid Pod and identity management.

Solid is a web decentralization project led by Tim Berners-Lee, the inventor of the World Wide Web. It aims to give individuals control over their data and enhance privacy by allowing data to be stored in personal online data stores (Pods). Solid promotes data interoperability and user empowerment. For more information, visit the [Solid project website](https://solidproject.org/).

## Installation

Ensure you have [Node.js](https://nodejs.org/) and [Yarn](https://yarnpkg.com/) installed:

```bash
yarn install
yarn build
```

## Quick Start

| Mode | Command | Description |
| --- | --- | --- |
| Local | `yarn local` | SQLite + local disk, no external dependencies |
| Server | `yarn server` | PostgreSQL + MinIO + Redis, production ready |
| Cluster Server | `yarn cluster:server` | Control plane for cloud-edge cluster |
| Cluster Local | `yarn cluster:local` | Edge node connecting to control plane |
| Dev | `yarn dev` | No auth, for API/frontend debugging |

Configure environment:
```bash
cp example.env .env.local     # For local/dev
cp example.env .env.server    # For server/production
```

Visit [http://localhost:3000/](http://localhost:3000/) after startup.

See [docs/deployment-modes.md](docs/deployment-modes.md) for detailed profile comparison and cloud-edge coordination.

## Roadmap

- [x] DB-Based Identity Provider
- [x] Fine-Grained Pod Capacity Management
- [x] SPARQL 1.1 via LDP (sparql-update)
- [x] Sidecar API: SPARQL (`/-/sparql`)
- [ ] Sidecar API: Vector (`/-/vector`)
- [ ] Sidecar API: Chat Completions (`/-/chat/completions`)
- [ ] Sidecar API: Responses (`/-/responses`)
- [ ] Sidecar API: Terminal (`/-/terminal`)
- [ ] Attribute-Based Access Control (ABAC)
- [ ] Feature Store (Federated Learning)

## Documentation

- [CLAUDE.md](CLAUDE.md) - Project overview, CSS architecture, development guidelines
- [docs/COMPONENTS.md](docs/COMPONENTS.md) - Component reference and database architecture
- [docs/deployment-modes.md](docs/deployment-modes.md) - Deployment profiles and cloud-edge coordination
- [docs/admin-guide.md](docs/admin-guide.md) - Admin initialization, roles, and reserved names
- [docs/usage-and-quota.md](docs/usage-and-quota.md) - Usage tracking, quota enforcement, external integration
- [docs/database-optimization.md](docs/database-optimization.md) - PostgreSQL indexes and performance tuning
- [docs/sidecar-api.md](docs/sidecar-api.md) - Sidecar API pattern (`/-/{service}`)
- [docs/sparql-support.md](docs/sparql-support.md) - SPARQL 1.1 support details

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) to understand how to contribute to the project.

## License

Xpod is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

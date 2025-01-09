# Xpod

Xpod is an extended [Community Solid Server (CSS)](https://github.com/solid/community-server), offering rich-feature, production-level Solid Pod and identity management.

Solid is a web decentralization project led by Tim Berners-Lee, the inventor of the World Wide Web. It aims to give individuals control over their data and enhance privacy by allowing data to be stored in personal online data stores (Pods). Solid promotes data interoperability and user empowerment. For more information, visit the [Solid project website](https://solidproject.org/).

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Components](#components)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Installation
To install Xpod, ensure you have [Node.js](https://nodejs.org/) and [Yarn](https://yarnpkg.com/) installed. Then run the following command:

```bash
yarn install
```

Before starting the application, you need to build the project. Run the following command:

```bash
yarn build
```

## Quick Start
To start Xpod, run the application in the desired mode:

- **Normal mode**: Can be started directly without setting environment variables. Structured resources stored in SQLite, unstructured resources stored in file system.
  ```bash
  yarn start
  ```

- **Local mode**: Requires environment variables. Structured resources stored in SQLite, unstructured resources stored in MinIO.
  ```bash
  yarn local
  ```

- **Server mode**: Requires environment variables. Structured resources stored in PostgreSQL, unstructured resources stored in MinIO.
  ```bash
  yarn server
  ```

- **Dev mode**: Similar to local mode but without resource authorization. Requires environment variables. Structured resources stored in SQLite, unstructured resources stored in MinIO.
  ```bash
  yarn dev
  ```

Click [http://localhost:3000/](http://localhost:3000/) to access the server.

### Optional: Configure Environment Variables

For modes that require environment variables, you need to configure them as follows:

1. Generate a `.env` file by copying `example.env`:
   ```bash
   cp example.env .env
   ```

2. Modify the `.env` file as needed to configure your environment variables.

## Components

### MinioDataAccessor
- **Path**: `src/storage/accessors/MinioDataAccessor.ts`
- **Implements**: `DataAccessor`.
- **Environment Variables**: `CSS_MINIO_ENDPOINT`, `CSS_MINIO_ACCESS_KEY`, `CSS_MINIO_SECRET_KEY`.
- **Main Functionality**: Handles storage and retrieval of resources using MinIO.

### QuadstoreSparqlDataAccessor
- **Path**: `src/storage/accessors/QuadstoreSparqlDataAccessor.ts`
- **Implements**: `DataAccessor`.
- **Environment Variables**: `CSS_SPARQL_ENDPOINT`.
- **Main Functionality**: Provides SPARQL query capabilities over data stored in Quadstore. Data must be able to convert to SPO triples. Supports mysql, sqlite, postgresql backend.

### MixDataAccessor
- **Path**: `src/storage/accessors/MixDataAccessor.ts`
- **Implements**: `DataAccessor`.
- **Main Functionality**: Integrates multiple data access methods to provide a unified interface. Structured resources stored in databases, unstructured resources stored in MinIO.

### RepresentationPartialConvertingStore
- **Path**: `src/storage/RepresentationPartialConvertingStore.ts`
- **Implements**: `ResourceStore`.
- **Main Functionality**: Converts resources to ensure compatibility across different storage formats.

## Roadmap

- [ ] **DB-Based Identity Provider**: Enables authentication providers to store data in the database, facilitating secure identity management and data storage.
- [ ] **Fine-Grained Pod Capacity Management**: Provides detailed control over the storage capacity of individual Pods, allowing for efficient resource allocation and management.
- [ ] **Vector Retrieval Support for AI Applications**: Enhances AI capabilities by enabling efficient vector-based data retrieval, supporting advanced AI and machine learning applications.
- [ ] **Attribute-Based Access Control（ABAC）**: Supports attribute-based access control, allowing for fine-grained control over resource access. Zero-knowledge proof is used to verify that users meet ABAC requirements without revealing sensitive information.
- [ ] **Feature Store Support**: Allows applications to define ETL (Extract, Transform, Load) logic for feature production. Ensures privacy-safe feature production, supporting Attribute-Based Access Control (ABAC) and federated learning.

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) to understand how to contribute to the project.

## License

Xpod is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

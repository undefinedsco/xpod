# Content Type Handling & Conversion Strategy

Xpod implements a strict "Zero Trust" strategy for handling content types to ensure data fidelity and prevent accidental data loss. This document explains how the system decides whether to parse a resource as RDF (and store it in the Quadstore) or treat it as a binary file (and store it in the File System/S3).

## 1. The Core Problem: Polyglot Formats

Many modern file formats are "Polyglot", meaning they can be interpreted in multiple ways.
*   **HTML/XHTML**: A document format, but can contain **RDFa** (RDF in attributes).
*   **Markdown**: A document format, but some parsers treat it as HTML-compatible and extract RDFa.
*   **XML**: A generic data format, but `RdfXmlParser` might try to extract RDF triples.

**The Risk**: If the system blindly uses any available RDF parser, uploading an `index.html` file might result in the parser extracting 0 triples (if no RDFa is present) and discarding the original HTML content. The user stores a file, but gets back an empty graph.

## 2. The Solution: Whitelist Strategy

To solve this, `RepresentationPartialConvertingStore` implements a **Strict Whitelist**. We only allow conversion for content types that are **explicitly and exclusively RDF**.

### 2.1 The Whitelist (`SAFE_RDF_TYPES`)

Only the following MIME types trigger the RDF conversion pipeline:

1.  `text/turtle`
2.  `application/ld+json` (JSON-LD)
3.  `application/n-triples`
4.  `application/n-quads`
5.  `application/trig`
6.  `text/n3`
7.  `application/rdf+xml`
8.  `internal/quads` (Internal CSS format)

### 2.2 Behavior Logic

When a user performs a `PUT` or `POST` request:

```mermaid
graph TD
    A[Incoming Request] --> B{Is Content-Type in Whitelist?}
    B -- YES --> C[Invoke RDF Parser]
    C --> D[Convert to Quads]
    D --> E[Store in Quadstore (SQLite/Postgres)]
    
    B -- NO --> F[Skip Conversion]
    F --> G[Pass through as Binary]
    G --> H[Store in File System / S3]
    G --> I[Write Metadata to Quadstore]
```

*   **Allowed**: `PUT data.ttl` -> Parsed -> Stored as Quads.
*   **Blocked (Pass-through)**: `PUT doc.md` -> Skipped -> Stored as File.
*   **Blocked (Pass-through)**: `PUT page.html` -> Skipped -> Stored as File.
*   **Blocked (Pass-through)**: `PUT image.png` -> Skipped -> Stored as File.

## 3. Storage Architecture

The storage layer (`MixDataAccessor`) automatically handles the routing based on the data stream it receives:

### 3.1 Structured Data (RDF)
*   **Trigger**: Incoming data is `internal/quads` (result of conversion).
*   **Storage**: **Quadstore** (SQLite or PostgreSQL).
*   **Feature**: Fully queryable via SPARQL.

### 3.2 Unstructured Data (Binary)
*   **Trigger**: Incoming data is a raw byte stream (e.g., `text/plain`, `image/png`).
*   **Storage**: 
    *   **Local Mode**: `FileDataAccessor` (Disk).
    *   **Server Mode**: `MinioDataAccessor` (S3/MinIO).
*   **Metadata**: The file's metadata (Size, Content-Type, Modified Time) is stored in the Quadstore in a separate Named Graph: `<resource-uri>.metadata`.

## 4. Developer Notes

If you need to support a new RDF format (e.g. `text/shaclc`), you must explicitly add it to the `SAFE_RDF_TYPES` set in `src/storage/RepresentationPartialConvertingStore.ts`. Do **not** rely on the parser's existence alone.

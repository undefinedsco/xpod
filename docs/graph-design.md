# LDP & SPARQL Compatibility Model

This document defines the architectural relationship between the Linked Data Platform (LDP) file-system model and the SPARQL Graph Store model in Xpod.

## 1. Graph Classification (Storage Model)

Xpod maps all resources to Named Graphs in the underlying Quadstore.

| LDP Resource Type | Quadstore Named Graph | Content |
| :--- | :--- | :--- |
| **RDF Resource** | `<http://pod/doc.ttl>` | User triples. |
| **Binary Resource** | **N/A** (File System) | Binary content (invisible to Quadstore). |
| **Metadata** | `<meta:http://pod/doc.ttl>` | System metadata (size, mtime, Content-Type). |
| **Container** | `<http://pod/folder/>` | Containment triples (`ldp:contains`) and user metadata for the folder. |

## 2. The Core Difference: Automation vs. Raw Access

The fundamental difference between operating via LDP and SPARQL is the level of automation regarding **Graph Targeting** and **Side Effects**.

### 2.1 LDP (The "Managed" Path)
LDP operations are high-level abstractions that handle graph management for you.

*   **Graph Targeting**: **Automatic**. `PUT` and `PATCH` automatically target the resource's Named Graph.
*   **Side Effects**: **Automatic**. Updates `mtime`, `size`, and `ldp:contains`.

### 2.2 SPARQL Sidecar (The "Raw" Path)
The Sidecar (`/-/sparql`) provides raw access to the underlying Quadstore.

*   **Graph Targeting**: **Manual**. You must explicitly specify `GRAPH <>` or `GRAPH <uri>`.
*   **Side Effects**: **Manual (None)**. No `mtime` updates. Useful for batch operations or raw data manipulation.

---

## 3. The Power of Full SPARQL: Changing the LDP Paradigm

Because Xpod is backed by a native Quadstore (not just files), the interaction model for LDP operations shifts significantly from "Document-Centric" to "Data-Centric".

### 3.1 PATCH vs. PUT (The Efficiency Leap)
*   **Traditional File-based LDP**: To change one triple, you must `GET` the whole file, parse it, modify it, and `PUT` the whole file back. Performance is **O(File Size)**.
*   **Xpod SPARQL-backed LDP**:
    *   **PATCH (application/sparql-update)**: You send only the delta (`INSERT/DELETE`).
    *   The backend executes this directly against the database (SQLite/Postgres).
    *   **Performance**: **O(Delta Size)**. You can modify a 1GB Dataset in milliseconds without loading it into memory.

### 3.2 GET vs. SELECT (Granular Access)
*   **Traditional**: `GET /data.ttl` downloads everything.
*   **Xpod**: You can use the Sidecar to query **exactly what you need**.
    *   `SELECT ?name WHERE { <#me> foaf:name ?name }`
    *   This avoids over-fetching and saves massive bandwidth for large datasets.

### 3.3 Summary of Operation Changes

| Operation | Traditional LDP (File) | Xpod (Graph Store) | Benefit |
| :--- | :--- | :--- | :--- |
| **GET** | Download Full File | Partial Read via SPARQL | Bandwidth Efficiency |
| **PUT** | Overwrite Full File | Overwrite Graph | Same (Atomic Replace) |
| **PATCH** | Read-Modify-Write (Slow) | **Direct DB Update (Fast)** | High Performance |
| **DELETE** | Delete File | Clear Graph | Same |

---

## 4. CRUD Capabilities & Interoperability

### 4.1 Intersection (RDF Data)
Both LDP and SPARQL have full Read/Write access to RDF resource content.

| Feature | LDP (via PUT/PATCH) | SPARQL Sidecar |
| :--- | :--- | :--- |
| **Update Scope** | Targets **One Resource** (The URL). | Can target **Any Graph** (in scope) via `GRAPH <uri>`. |
| **Update Syntax** | `application/sparql-update` (PATCH). | Standard SPARQL Update (POST). |
| **Consistency** | Strong (mtime updated). | Weak (Raw data only). |

### 4.2 Hierarchy & Metadata
*   **LDP**: Manages hierarchy implicitly via file creation/deletion.
*   **SPARQL**: Can **Query** hierarchy (`SELECT ?child WHERE { <folder/> ldp:contains ?child }`).
    *   Can **Modify** hierarchy manually (e.g., deleting a containment triple "hides" a resource from LDP listing, creating a "Ghost Resource").

### 4.3 Binary Data
*   **LDP**: Full CRUD on binary content.
*   **SPARQL**: **Metadata Only**. Can read/write the `<meta:uri>` graph (custom descriptions, labels), but cannot touch the binary blob.

---

## 5. Summary Recommendation

*   **Use LDP PATCH**: For **High-Performance Updates**. This is the preferred way to modify data.
*   **Use SPARQL Sidecar**: For **Complex Queries** and **Batch/Cross-Graph Updates**.
*   **Use LDP PUT**: For creating new resources or atomic replacements.
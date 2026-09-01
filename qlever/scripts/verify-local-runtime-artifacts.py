#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import selectors
import sqlite3
import subprocess
from pathlib import Path


def create_smoke_database(path: Path) -> None:
    with sqlite3.connect(path) as database:
        database.executescript(
            """
            CREATE TABLE rdf_terms (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL,
              value TEXT NOT NULL,
              value_head TEXT NOT NULL,
              datatype_id INTEGER,
              lang TEXT,
              hash TEXT NOT NULL,
              normalized_text TEXT,
              numeric_value REAL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE UNIQUE INDEX rdf_terms_identity_hash ON rdf_terms (hash);
            CREATE INDEX rdf_terms_kind_value_head ON rdf_terms (kind, value_head);
            CREATE INDEX rdf_terms_kind_datatype ON rdf_terms (kind, datatype_id);
            CREATE INDEX rdf_terms_kind_lang ON rdf_terms (kind, lang);
            CREATE INDEX rdf_terms_kind_numeric_value ON rdf_terms (kind, numeric_value);
            CREATE TABLE rdf_sources (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source TEXT NOT NULL UNIQUE,
              workspace TEXT NOT NULL,
              local_path TEXT,
              content_type TEXT,
              last_indexed_at TEXT,
              source_version TEXT
            );
            CREATE TABLE rdf_quads (
              graph_id INTEGER NOT NULL,
              subject_id INTEGER NOT NULL,
              predicate_id INTEGER NOT NULL,
              object_id INTEGER NOT NULL,
              source_file_id INTEGER,
              source_line_no INTEGER,
              PRIMARY KEY (graph_id, subject_id, predicate_id, object_id),
              FOREIGN KEY (graph_id) REFERENCES rdf_terms(id),
              FOREIGN KEY (subject_id) REFERENCES rdf_terms(id),
              FOREIGN KEY (predicate_id) REFERENCES rdf_terms(id),
              FOREIGN KEY (object_id) REFERENCES rdf_terms(id),
              FOREIGN KEY (source_file_id) REFERENCES rdf_sources(id)
            );
            CREATE INDEX rdf_quads_spog ON rdf_quads(subject_id, predicate_id, object_id, graph_id);
            CREATE INDEX rdf_quads_sopg ON rdf_quads(subject_id, object_id, predicate_id, graph_id);
            CREATE INDEX rdf_quads_psog ON rdf_quads(predicate_id, subject_id, object_id, graph_id);
            CREATE INDEX rdf_quads_posg ON rdf_quads(predicate_id, object_id, subject_id, graph_id);
            CREATE INDEX rdf_quads_ospg ON rdf_quads(object_id, subject_id, predicate_id, graph_id);
            CREATE INDEX rdf_quads_opsg ON rdf_quads(object_id, predicate_id, subject_id, graph_id);
            CREATE INDEX rdf_quads_gspo ON rdf_quads(graph_id, subject_id, predicate_id, object_id);
            CREATE INDEX rdf_quads_gpos ON rdf_quads(graph_id, predicate_id, object_id, subject_id);
            CREATE INDEX rdf_quads_source ON rdf_quads(source_file_id);
            CREATE TABLE rdf_index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO rdf_index_metadata(key, value) VALUES ('data_version', '0');
            INSERT INTO rdf_index_metadata(key, value) VALUES ('schema_version', '1');
            CREATE TABLE rdf_text_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE rdf_text_sources (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_key TEXT NOT NULL UNIQUE,
              source TEXT NOT NULL UNIQUE,
              workspace TEXT NOT NULL,
              local_path TEXT,
              content_type TEXT,
              source_version TEXT,
              source_hash TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE TABLE rdf_text_rebuild_status (
              source TEXT PRIMARY KEY,
              workspace TEXT NOT NULL,
              local_path TEXT,
              content_type TEXT,
              source_version TEXT,
              source_hash TEXT,
              status TEXT NOT NULL,
              reason TEXT,
              message TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE TABLE rdf_text_chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_id INTEGER NOT NULL,
              chunk_key TEXT NOT NULL,
              retrieval_kind TEXT NOT NULL DEFAULT 'file-chunk',
              ordinal INTEGER NOT NULL,
              level INTEGER NOT NULL,
              heading TEXT,
              path TEXT,
              content TEXT NOT NULL,
              start_offset INTEGER NOT NULL,
              end_offset INTEGER NOT NULL,
              normalized_text TEXT NOT NULL,
              token_count INTEGER NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              UNIQUE (source_id, chunk_key)
            );
            CREATE TABLE rdf_text_terms (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              term TEXT NOT NULL,
              source_id INTEGER NOT NULL,
              chunk_id INTEGER NOT NULL,
              occurrences INTEGER NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              UNIQUE (term, chunk_id)
            );
            CREATE TABLE rdf_text_entities (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              entity TEXT NOT NULL,
              source_id INTEGER NOT NULL,
              chunk_id INTEGER NOT NULL,
              predicate TEXT,
              label TEXT,
              value TEXT,
              datatype TEXT,
              language TEXT,
              policy_role TEXT,
              occurrences INTEGER NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE TABLE rdf_vector_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE rdf_vector_sources (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_key TEXT NOT NULL UNIQUE,
              source TEXT NOT NULL UNIQUE,
              workspace TEXT NOT NULL,
              local_path TEXT,
              content_type TEXT,
              source_version TEXT,
              source_hash TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE TABLE rdf_vector_chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_id INTEGER NOT NULL,
              chunk_key TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              level INTEGER NOT NULL,
              heading TEXT,
              path TEXT,
              content TEXT NOT NULL,
              start_offset INTEGER NOT NULL,
              end_offset INTEGER NOT NULL,
              embedding_json TEXT NOT NULL,
              summary_metadata TEXT,
              dimensions INTEGER NOT NULL,
              magnitude REAL NOT NULL,
              provider TEXT NOT NULL DEFAULT '',
              model TEXT NOT NULL,
              model_version TEXT NOT NULL DEFAULT '',
              input_kind TEXT NOT NULL DEFAULT '',
              input_hash TEXT NOT NULL DEFAULT '',
              projection_policy_version TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              UNIQUE (
                source_id,
                chunk_key,
                provider,
                model,
                model_version,
                input_kind,
                projection_policy_version,
                input_hash
              )
            );
            CREATE TABLE rdf_vector_components (
              chunk_id INTEGER NOT NULL,
              dimension INTEGER NOT NULL,
              value REAL NOT NULL,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              PRIMARY KEY (chunk_id, dimension)
            );
            INSERT INTO rdf_text_metadata(key, value) VALUES ('schema_version', '3');
            INSERT INTO rdf_vector_metadata(key, value) VALUES ('schema_version', '2');
            INSERT INTO rdf_sources(id, source, workspace, local_path, content_type)
              VALUES (1, 'urn:xpod:smoke:source', 'smoke', '/smoke', 'text/plain');
            INSERT INTO rdf_terms(id, kind, value, value_head, hash)
              VALUES (
                1, 'iri', 'urn:xpod:smoke:source', 'urn:xpod:smoke:source',
                'smoke-source-term'
              );
            INSERT INTO rdf_terms(id, kind, value, value_head, hash) VALUES
              (2, 'default_graph', '', '', 'smoke-default-graph'),
              (3, 'iri', 'urn:xpod:smoke:s:default', 'urn:xpod:smoke:s:default', 'smoke-default-subject'),
              (4, 'iri', 'urn:xpod:smoke:p:value', 'urn:xpod:smoke:p:value', 'smoke-value-predicate'),
              (5, 'literal', 'default', 'default', 'smoke-default-object'),
              (6, 'iri', 'urn:xpod:smoke:s:named', 'urn:xpod:smoke:s:named', 'smoke-named-subject'),
              (7, 'literal', 'named', 'named', 'smoke-named-object'),
              (8, 'iri', 'urn:xpod:smoke:g:allowed', 'urn:xpod:smoke:g:allowed', 'smoke-named-graph');
            INSERT INTO rdf_quads(
              graph_id, subject_id, predicate_id, object_id, source_file_id, source_line_no
            ) VALUES
              (2, 3, 4, 5, 1, NULL),
              (8, 6, 4, 7, 1, NULL);
            INSERT INTO rdf_text_sources(id, source_key, source, workspace, local_path, content_type)
              VALUES (1, 'urn:xpod:smoke:source', 'urn:xpod:smoke:source', 'smoke', '/smoke', 'text/plain');
            INSERT INTO rdf_text_chunks(
              id, source_id, chunk_key, retrieval_kind, ordinal, level, heading, path,
              content, start_offset, end_offset, normalized_text, token_count
            ) VALUES (
              1, 1, 'chunk-1', 'file-chunk', 0, 0, NULL, NULL,
              'alpha card', 0, 10, 'alpha card', 2
            );
            INSERT INTO rdf_text_terms(id, term, source_id, chunk_id, occurrences)
              VALUES (1, 'alpha', 1, 1, 1);
            INSERT INTO rdf_vector_sources(id, source_key, source, workspace, local_path, content_type)
              VALUES (1, 'urn:xpod:smoke:source', 'urn:xpod:smoke:source', 'smoke', '/smoke', 'text/plain');
            INSERT INTO rdf_vector_chunks(
              id, source_id, chunk_key, ordinal, level, heading, path, content,
              start_offset, end_offset, embedding_json, dimensions, magnitude,
              provider, model, model_version, input_kind, input_hash,
              projection_policy_version
            ) VALUES (
              1, 1, 'chunk-1', 0, 0, NULL, NULL, 'alpha card',
              0, 10, '[1.0,0.0]', 2, 1.0,
              'xpod', 'smoke-model', '2026-08-12', 'entity-card',
              'sha256:smoke', 'policy-v1'
            );
            INSERT INTO rdf_vector_components(chunk_id, dimension, value)
              VALUES (1, 0, 1.0), (1, 1, 0.0);
            """
        )


def readline_with_timeout(
    process: subprocess.Popen[str], timeout_seconds: float, context: str
) -> str:
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        events = selector.select(timeout_seconds)
    finally:
        selector.close()
    if events:
        line = process.stdout.readline()
        if line:
            return line
    process.kill()
    _, stderr = process.communicate(timeout=5)
    raise SystemExit(f"runtime {context} timed out: {stderr}")


def sparql_bindings(response: str) -> list[dict[str, object]]:
    envelope = json.loads(response)
    body = json.loads(envelope["result"]["body"])
    bindings = body["results"]["bindings"]
    if not isinstance(bindings, list):
        raise TypeError("SPARQL bindings must be a list")
    return bindings


def run_runtime_smoke(runtime_path: Path, smoke_database: Path) -> tuple[int, int]:
    smoke = subprocess.Popen(
        [
            str(runtime_path),
            "--sqlite-path",
            str(smoke_database),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert smoke.stdin is not None
    assert smoke.stdout is not None

    ready = readline_with_timeout(smoke, 10, "ready smoke")
    if '"type":"ready"' not in ready:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(f"runtime ready smoke failed: {ready}{stderr}")
    try:
        ready_message = json.loads(ready)
        adapter_abi = int(ready_message["adapterAbiVersion"])
        physical_backend_abi = int(ready_message["physicalBackendAbiVersion"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(f"runtime ready ABI smoke failed: {ready}{stderr}") from exc

    def request(message: dict[str, object]) -> str:
        assert smoke.stdin is not None
        assert smoke.stdout is not None
        smoke.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        smoke.stdin.flush()
        line = readline_with_timeout(smoke, 10, "query smoke")
        if '"type":"result"' not in line or '"status":"ok"' not in line:
            smoke.kill()
            _, stderr = smoke.communicate(timeout=5)
            raise SystemExit(f"runtime query smoke failed: {line}{stderr}")
        return line

    fts = request(
        {
            "id": "fts",
            "type": "query",
            "sparql": 'SELECT ?text WHERE { ?text ql:contains-word "alpha" }',
        }
    )
    try:
        fts_rows = sparql_bindings(fts)
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            f"runtime FTS smoke returned an invalid envelope: {fts}{stderr}"
        ) from exc
    if not any(
        row.get("text") == {"type": "literal", "value": "alpha card"}
        for row in fts_rows
    ):
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(f"runtime FTS smoke returned no text chunk: {fts}{stderr}")

    vector = request(
        {
            "id": "vector",
            "type": "query",
            "sparql": "SELECT ?retrieval WHERE { }",
            "options": {
                "vectorQuery": {
                    "embedding": [1.0, 0.0],
                    "provider": "xpod",
                    "model": "smoke-model",
                    "modelVersion": "2026-08-12",
                    "inputKind": "entity-card",
                    "projectionPolicyVersion": "policy-v1",
                    "metric": "cosine",
                    "limit": 1,
                    "retrievalPointVariable": "?retrieval",
                }
            },
        }
    )
    try:
        vector_rows = sparql_bindings(vector)
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            f"runtime vector smoke returned an invalid envelope: {vector}{stderr}"
        ) from exc
    if not any(
        row.get("retrieval") == {"type": "literal", "value": "chunk-1"}
        for row in vector_rows
    ):
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            f"runtime vector smoke returned no retrieval point: {vector}{stderr}"
        )

    graph = request(
        {
            "id": "default-named-graph",
            "type": "query",
            "sparql": (
                "SELECT ?s ?o ?g WHERE { "
                "{ ?s <urn:xpod:smoke:p:value> ?o "
                "BIND(<urn:xpod:smoke:g:default> AS ?g) } UNION "
                "{ GRAPH ?g { ?s <urn:xpod:smoke:p:value> ?o } } "
                "} ORDER BY ?g ?s"
            ),
            "options": {
                "basePath": "urn:xpod:smoke:",
                "accessScope": {
                    "basePath": "urn:xpod:smoke:",
                    "mode": "read",
                    "resolved": True,
                    "principal": "urn:xpod:smoke:reader",
                    "version": "smoke-default-named-v1",
                },
            },
        }
    )
    try:
        graph_rows = sparql_bindings(graph)
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            f"runtime default/named graph smoke returned an invalid envelope: {graph}{stderr}"
        ) from exc
    expected_graph_rows = [
        {
            "s": {"type": "uri", "value": "urn:xpod:smoke:s:named"},
            "o": {"type": "literal", "value": "named"},
            "g": {"type": "uri", "value": "urn:xpod:smoke:g:allowed"},
        },
        {
            "s": {"type": "uri", "value": "urn:xpod:smoke:s:default"},
            "o": {"type": "literal", "value": "default"},
            "g": {"type": "uri", "value": "urn:xpod:smoke:g:default"},
        },
    ]
    if graph_rows != expected_graph_rows:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            "runtime default/named graph smoke mismatch: "
            f"actual={graph_rows!r} expected={expected_graph_rows!r}{stderr}"
        )

    prepared = request(
        {
            "id": "graph-derived-source-prepare-update",
            "type": "query",
            "sparql": (
                "INSERT DATA { GRAPH <urn:xpod:smoke:new-document> { "
                "<urn:xpod:smoke:s:new> <urn:xpod:smoke:p:value> \"new\" "
                "} }"
            ),
            "options": {
                "basePath": "urn:xpod:smoke:",
                "operation": "prepareUpdate",
                "acceptMediaType": (
                    "application/vnd.xpod.rdf-prepared-delta+json;version=1"
                ),
                "accessScope": {
                    "basePath": "urn:xpod:smoke:",
                    "mode": "write",
                    "resolved": True,
                    "principal": "urn:xpod:smoke:writer",
                    "version": "smoke-graph-derived-source-v1",
                },
            },
        }
    )
    try:
        prepared_envelope = json.loads(prepared)
        prepared_result = prepared_envelope["result"]
        prepared_delta = json.loads(prepared_result["body"])
        prepared_graphs = prepared_delta["graphs"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            "runtime graph-derived source prepare-update smoke returned an "
            f"invalid envelope: {prepared}{stderr}"
        ) from exc
    if (
        prepared_result.get("mediaType")
        != "application/vnd.xpod.rdf-prepared-delta+json;version=1"
        or not isinstance(prepared_graphs, list)
        or not any(
            graph.get("sourceUri") == "urn:xpod:smoke:new-document"
            for graph in prepared_graphs
            if isinstance(graph, dict)
        )
    ):
        smoke.kill()
        _, stderr = smoke.communicate(timeout=5)
        raise SystemExit(
            "runtime graph-derived source prepare-update smoke mismatch: "
            f"{prepared}{stderr}"
        )

    assert smoke.stdin is not None
    smoke.stdin.write('{"type":"shutdown"}\n')
    smoke.stdin.flush()
    _, stderr = smoke.communicate(timeout=10)
    if smoke.returncode != 0:
        raise SystemExit(f"runtime shutdown smoke failed: {stderr}")
    return adapter_abi, physical_backend_abi


def artifact(prefix: Path, path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    return {
        "path": str(path.relative_to(prefix)),
        "sha256": digest,
        "size": os.path.getsize(path),
    }


def runtime_artifacts(prefix: Path, runtime_path: Path) -> list[dict[str, object]]:
    paths = [runtime_path]
    library_root = prefix / "lib"
    if library_root.is_dir():
        paths.extend(sorted(path for path in library_root.rglob("*") if path.is_file()))
    return [artifact(prefix, path) for path in paths]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    provenance = parser.add_mutually_exclusive_group(required=True)
    provenance.add_argument("--prior-sdk-image")
    provenance.add_argument("--build-source")
    parser.add_argument("--smoke-database", required=True, type=Path)
    args = parser.parse_args()

    prefix = args.prefix
    runtime_path = prefix / "bin/xpod_qlever_local_runtime"

    if args.smoke_database.exists():
        args.smoke_database.unlink()
    create_smoke_database(args.smoke_database)
    adapter_abi, physical_backend_abi = run_runtime_smoke(
        runtime_path,
        args.smoke_database,
    )

    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    build = (
        {
            "source": "focused-prior-runtime-sdk",
            "priorSdkImage": args.prior_sdk_image,
            "entrypoint": "qlever/scripts/run-focused-native-build.sh",
        }
        if args.prior_sdk_image
        else {
            "source": "native-platform-build",
            "platform": args.build_source,
            "entrypoint": "qlever/scripts/build-macos-local-runtime.sh",
        }
    )
    manifest = {
        "schemaVersion": 1,
        "adapterAbiVersion": adapter_abi,
        "physicalBackendAbiVersion": physical_backend_abi,
        "qlever": {
            "repository": lock["repository"],
            "commit": lock["commit"],
            "patchSeriesSha256": lock["patchSeriesSha256"],
        },
        "build": build,
        "artifacts": runtime_artifacts(prefix, runtime_path),
    }
    manifest_path = prefix / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    with manifest_path.open("rb") as handle:
        manifest_sha = hashlib.file_digest(handle, "sha256").hexdigest()
    print(
        json.dumps(
            {
                "manifestSha256": manifest_sha,
                "adapterAbiVersion": adapter_abi,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

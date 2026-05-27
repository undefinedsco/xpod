# CLI Spec

This document defines the intended xpod CLI surface for humans, scripts, and
portable AI agents. xpod is an operations and Pod resource tool. It must not
contain AI-specific business logic, and it must treat all model/schema resources
uniformly.

Status: canonical CLI product/tooling specification for this repository. Current
implementation may lag this spec.

## Command Framework

The CLI is split by authority and semantic layer:

```text
xpod get <path-or-url>
xpod put <path-or-url> --from <file> [--content-type <type>] [--if-match <etag>]
xpod patch <path-or-url> --from <file> [--content-type <type>] [--if-match <etag>]
xpod delete <path-or-url> [--if-match <etag>]
xpod head <path-or-url>
xpod list <container-path> [--depth 1]

xpod auth status|login|logout|whoami

xpod server start|stop|status|health|logs
xpod server config get|set|list

xpod rdf ...
xpod obj ...
xpod secret ...
```

Top-level `get`, `put`, `patch`, `delete`, `head`, and `list` are raw Pod
resource operations. They are curl-like in spirit, but xpod does not provide a
`curl` compatibility command or accept arbitrary curl flags. These commands must
not parse business models, infer descriptor-backed paths, or apply application
semantics. Model-aware operations belong under `obj`; graph-level operations
belong under `rdf`.

`run` is not a CLI concept. Foreground startup, if needed, is expressed as:

```bash
xpod server start --foreground
```

## Boundary With `udfs`

`udfs` from `@undefineds.co/models` is the schema/model contract CLI.

Use `udfs` for:

- listing known model descriptors;
- discovering classes and predicates;
- searching model definitions;
- validating descriptor-backed mutations;
- future schema/model authoring if the models package owns it.

Use `xpod` for:

- authenticated raw Pod resource operations;
- RDF graph operations over concrete resources, subjects, and triples;
- descriptor-backed object transport using shared model descriptors;
- import/export from the user's Pod root;
- secret-safe writes;
- local/server xpod administration.

xpod may call or vendor `@undefineds.co/models` descriptors, but it must not
fork the model registry or create a second schema-authoring surface.

Product code that already has an in-process model session should use
`@undefineds.co/models` plus `drizzle-solid` directly. The `xpod` command line
is the stable tool surface for humans, scripts, and portable agents outside
that process.

## Design Principles

- Paths are Pod-root relative by default, for example
  `settings/credentials.ttl` or `chat/default/index.ttl#this`.
- Commands that accept a path may also accept an absolute Pod URL.
- Commands must resolve and report the effective WebID, Pod root, base IRI, and
  resource URL in JSON output when that context affects the result.
- The CLI is explicit, scriptable, and stable. It must not require an
  AI-specific protocol.
- Every mutating command supports dry-run/plan output before commit unless the
  operation is explicitly defined as a direct raw HTTP operation.
- Structured output is JSON when `--json` is passed.
- Batch commands return item `index` plus machine-readable `code`.
- Secrets are never echoed by default and are never sent to an LLM by xpod.

## Output Contract

All JSON commands should use this envelope:

```json
{
  "ok": true,
  "code": "ok",
  "data": {},
  "warnings": []
}
```

Errors should use:

```json
{
  "ok": false,
  "code": "resource_not_found",
  "message": "Resource not found: settings/missing.ttl",
  "warnings": []
}
```

Mutating semantic commands should return a plan on dry-run and a final decision
on commit. Plans should be useful for humans, scripts, agents, and external host
policy layers:

```json
{
  "ok": true,
  "code": "plan_ready",
  "data": {
    "operationId": "op_123",
    "webId": "https://id.example/alice/profile/card#me",
    "podRoot": "https://pod.example/alice/",
    "summary": "Patch one descriptor-backed object",
    "risk": "normal",
    "resources": [
      {
        "subject": "https://pod.example/alice/.data/workflow/evidence.ttl#ev1",
        "schema": "https://undefineds.co/ns#Evidence",
        "etag": "\"abc\"",
        "change": "patch"
      }
    ],
    "diff": []
  },
  "warnings": []
}
```

Batch commands should include per-item status:

```json
{
  "ok": false,
  "code": "partial_failure",
  "items": [
    { "index": 0, "ok": true, "code": "ok", "resource": "settings/a.ttl#x" },
    { "index": 1, "ok": false, "code": "predicate_unknown", "message": "..." }
  ],
  "warnings": []
}
```

## Auth

xpod must make the acting identity explicit and must not surprise
non-interactive callers with a browser login flow.

Required commands:

```bash
xpod auth status [--json]
xpod auth login [--issuer <url>]
xpod auth logout
xpod auth whoami [--json]
```

Rules:

- In interactive mode, commands may explain how to log in when no session is
  available.
- In `--json`, CI, or non-interactive mode, missing auth returns
  `code: "auth_required"` and never opens a browser.
- If multiple accounts are configured, the selected account must be explicit
  through current account/server selection config or a command option. xpod
  should not guess from path text when that would change authority.
- Commands must not print access tokens, refresh tokens, client secrets,
  cookies, or authorization headers unless a human-only debug flag explicitly
  requests it.

## Raw Pod Resource Operations

Top-level resource commands operate on Solid resources from the selected Pod
root. They provide authenticated HTTP access without exposing tokens.

Required commands:

```bash
xpod get <path-or-url> [--accept <type>] [--out <file>] [--json]
xpod put <path-or-url> --from <local-file> [--content-type <type>] [--if-match <etag>] [--json]
xpod patch <path-or-url> --from <local-file> [--content-type <type>] [--if-match <etag>] [--json]
xpod delete <path-or-url> [--if-match <etag>] [--json]
xpod head <path-or-url> [--json]
xpod list <container-path> [--depth 1] [--json]
```

Rules:

- These commands are raw resource operations only. They must not interpret
  descriptor-backed object semantics.
- Relative paths resolve against the selected Pod root.
- Absolute URLs are allowed, but output must still report effective WebID, Pod
  root, base IRI, and resource URL when `--json` is used.
- `put`, `patch`, and `delete` should support stale-write protection with
  `--if-match` whenever the target resource exposes an etag.
- `list` is a container resource listing. It may parse LDP containment metadata
  but must not interpret business classes.

## RDF

The RDF surface manipulates concrete RDF resources, subjects, and triples, not
application business semantics.

Required commands:

```bash
xpod rdf get <resource-or-subject>
xpod rdf patch <resource> --insert <ttl-or-file> [--delete <ttl-or-file>] [--if-match <etag>]
xpod rdf query --sparql <query-or-file>
xpod rdf classes [--schema <schema-uri>]
xpod rdf predicates [--schema <schema-uri>] [--field <field>]
```

`rdf classes` and `rdf predicates` may delegate to `udfs` or models descriptors
for known schemas. The command name stays under `rdf` because RDF defines the
graph layer; the model registry remains owned by `@undefineds.co/models`.

RDF mutations should support stale-write protection with `--if-match` whenever
the target resource exposes an etag. Query commands must be read-only.

## Object Exchange

xpod should support two stable resource exchange formats:

- file-to-file: copy or transform bytes/resources without interpreting model
  semantics;
- file-to-json-list: export RDF/model-backed objects into JSONL for agents,
  scripts, import review, or offline processing.

Required commands:

```bash
xpod obj export <selector> --format jsonl --out <file>
xpod obj import <file.jsonl> --dry-run
xpod obj import <file.jsonl> --commit
```

Selectors must be precise enough for model-backed control objects. At minimum,
they must support schema URI, subject/resource URI, path, status, relation
filters, limit, and inclusion of revision/etag metadata. This lets portable
agents inspect and update workflow objects without guessing Pod paths or writing
raw Turtle.

Ergonomic command aliases may be added on top of import/export, but they must
still use the same model descriptors and output contract:

```bash
xpod obj get --schema <schema-uri> --subject <subject-or-id>
xpod obj list --schema <schema-uri> [--where <json>] [--limit <n>]
xpod obj upsert --schema <schema-uri> --from <file.jsonl|-> --dry-run
xpod obj upsert --schema <schema-uri> --from <file.jsonl|-> --commit
xpod obj patch --subject <subject> --set <json> [--if-match <etag>] --dry-run
xpod obj patch --subject <subject> --set <json> [--if-match <etag>] --commit
xpod obj link --subject <subject> --predicate <uri-or-field> --object <uri> --dry-run
xpod obj link --subject <subject> --predicate <uri-or-field> --object <uri> --commit
xpod obj delete --subject <subject> [--if-match <etag>] --dry-run
xpod obj delete --subject <subject> [--if-match <etag>] --commit
```

Each JSONL row should be self-describing:

```json
{"op":"upsert","schema":"https://undefineds.co/ns#Credential","match":{"service":"ai","providerId":"openai","secretType":"api-key"},"set":{"label":"OpenAI"}}
```

Multiple classes may appear in one JSONL file. xpod validates each row through
the shared model descriptors when a `schema` is present. Rows without `schema`
are treated as raw resource or RDF-level operations and must declare an
explicit path or subject.

Each exported row should include the resolved `subject` and, when available,
`etag` or revision metadata. Mutating rows may include `ifMatch` so control
planes can reject stale worker results instead of overwriting newer Pod state.

Reverse sync from Pod to business-specific behavior should be evented, not
hardcoded into xpod. xpod emits changed resources/JSON rows; the caller or
framework decides how to turn them into app-specific actions.

Required watch command:

```bash
xpod obj watch <selector> --format jsonl
xpod obj watch <selector> --format jsonl --since <cursor>
```

`watch` streams changed rows with stable item `index`, `code`, `subject`,
schema, revision/etag when available, and change kind. It is a transport for
Pod changes, not a product-specific controller.

When no durable cursor is available, xpod must say so in the stream metadata
and include enough subject/etag/change metadata for callers to reconcile with a
fresh `obj list`.

## Descriptor-Backed Objects

xpod must not define business models, RDF predicates, URI templates, lifecycle
state machines, field aliases, relation direction, status vocabularies,
fingerprints, or closure semantics. Those belong to `@undefineds.co/models`.

xpod only provides a descriptor-backed object transport: given a schema
descriptor and a subject, selector, relation filter, or JSONL row, it validates
and reads/writes the corresponding Pod resources.

Descriptor-backed objects must be queryable by descriptor fields and URI
relations, not only by broad path scans. Portable agents need a generic lookup
surface like:

```bash
xpod obj list --schema <schema-uri-or-alias> --where '{"status":"active"}'
xpod obj list --schema <schema-uri-or-alias> --where '{"subject":"<resource-uri>"}'
xpod obj list --schema <schema-uri-or-alias> --where '{"<relationField>":"<resource-uri>"}'
xpod obj list --schema <schema-uri-or-alias> --where '{"fingerprint":"<stable-fingerprint>"}'
```

xpod should accept only descriptor-known fields unless the caller is
intentionally using raw RDF commands. If a class is missing from
`@undefineds.co/models`, xpod should report `schema_unknown` rather than
inventing a private path, predicate, or fallback object type.

## Secrets

Secret handling is special only because the value must not be exposed to model
context, normal output, or logs.

Required commands:

```bash
xpod secret plan --kind <kind> --provider <provider> [--service <service>]
xpod secret set --kind <kind> --provider <provider> --from-stdin
xpod secret get-metadata <selector>
xpod secret revoke <selector>
```

Rules:

- `secret set` reads from stdin, local secure storage, or an approved file
  handle.
- Secret values must not be printed by default.
- Secret fields must be redacted in structured output.
- Secret resources may use the same descriptor-backed model resources as
  ordinary credential objects. The descriptor still owns the durable schema.

## Server Administration

Operations unrelated to Pod resources remain xpod server administration:

```bash
xpod server start [--env <path>] [--mode <local|cloud>] [--config <path>] [--port <number>] [--host <host>] [--foreground]
xpod server stop [--env <path>] [--timeout <ms>] [--json]
xpod server status [--env <path>] [--json]
xpod server health [--env <path>] [--json]
xpod server logs [--service <name>] [--level <level>] [--limit <n>] [--json]
xpod server config get <key> [--json]
xpod server config set <key> <value> [--json]
xpod server config list [--json]
```

These commands manage the local/server xpod process and service configuration.
They must use the same output contract but are not RDF/model commands.

Backward-compatible aliases may remain temporarily:

```text
xpod start  -> xpod server start
xpod stop   -> xpod server stop
xpod status -> xpod server status
xpod logs   -> xpod server logs
```

Top-level `xpod config` should not mean Pod, AI, or model configuration. If it
is retained for compatibility, it may only alias `xpod server config`.

## Non-Goals

- xpod does not decide where a high-level user memory should be stored without
  model descriptors or caller intent.
- xpod does not define model classes, fields, relation names, status values,
  lifecycle semantics, URI templates, or fingerprints.
- xpod does not run an AI consensus/modeling loop.
- xpod does not own product-specific secretary, workflow, or controller logic.
- xpod does not replace `udfs` as the model/schema CLI.
- xpod does not add approval/grant policy. Approval and grant objects are just
  descriptor-backed objects from xpod's perspective.
- xpod does not provide a curl compatibility surface.

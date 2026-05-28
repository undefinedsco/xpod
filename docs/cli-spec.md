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
xpod mkdir <container-path> [--parents]
xpod delete <path-or-url> [--if-match <etag>] [--recursive]
xpod head <path-or-url>
xpod list <container-path> [--depth 1]

xpod auth status|login|logout|whoami

xpod server start|stop|status|health|logs
xpod server config get|set|list

xpod rdf ...
xpod obj ...
xpod secret ...
```

Top-level `list`, `get`, `put`, `mkdir`, `delete`, `head`, and `patch` are raw
Pod resource operations. They are filesystem-like for stable resource paths and
HTTP-aware for content negotiation, etags, and status reporting, but xpod does
not provide a `curl` compatibility command or accept arbitrary curl flags. These
commands must not parse business models, infer model-backed paths, or apply
application semantics. Model-aware operations belong under `obj`; graph-level
operations belong under `rdf`.

`run` is not a CLI concept. Foreground startup, if needed, is expressed as:

```bash
xpod server start --foreground
```

## Boundary With `udfs` And Models

`@undefineds.co/models` owns durable shared model semantics. `udfs` may expose
schema/model discovery and authoring workflows for that package, but `xpod`
must only consume the shared model catalog/resource APIs.

Use `udfs` for:

- listing known model definitions;
- discovering classes and predicates;
- searching model definitions;
- validating model-backed mutations;
- future schema/model authoring if the models package owns it.

Use `xpod` for:

- authenticated raw Pod resource operations;
- RDF graph operations over concrete resources, subjects, and triples;
- model-backed object transport using the shared model catalog;
- import/export from the user's Pod root;
- secret-safe writes;
- local/server xpod administration.

xpod may consume compatibility descriptor-style metadata exported by
`@undefineds.co/models`, but it must treat it as derived interop metadata. It
must not fork the model registry, invent fallback schemas, hardcode product
paths, or create a second schema-authoring surface.

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
    "summary": "Patch one model-backed object",
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
xpod mkdir <container-path> [--parents] [--json]
xpod delete <path-or-url> [--if-match <etag>] [--recursive] [--json]
xpod head <path-or-url> [--json]
xpod list <container-path> [--depth 1] [--json]
```

Rules:

- These commands are raw resource operations only. They must not interpret
  model-backed object semantics.
- Relative paths resolve against the selected Pod root.
- Absolute URLs are allowed, but output must still report effective WebID, Pod
  root, base IRI, and resource URL when `--json` is used.
- Container paths are canonicalized to Solid container resources. A user may
  pass `notes` or `notes/`, but JSON output must report the effective container
  URL with a trailing slash.
- `put`, `patch`, and `delete` should support stale-write protection with
  `--if-match` whenever the target resource exposes an etag.
- `list` is a container resource listing. It may parse LDP containment metadata
  but must not interpret business classes.
- `mkdir` creates an LDP container, not an application folder object.
  `--parents` may create missing ancestor containers and should report every
  created or already-existing container in JSON output.
- `delete` removes one resource by default. Deleting a non-empty container
  requires `--recursive`; without it, the command must fail with a
  machine-readable code instead of silently deleting contained resources.
- File-system-style aliases may be provided for human ergonomics, but the
  canonical script and agent surface remains the explicit commands above:
  `ls -> list`, `rm -> delete`, `rmdir -> delete` for empty containers, and
  `stat -> head`.

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

`rdf classes` and `rdf predicates` may delegate to `udfs` or the models catalog
for known schemas. The command name stays under `rdf` because RDF defines the
graph layer; the model registry remains owned by `@undefineds.co/models`.

RDF mutations should support stale-write protection with `--if-match` whenever
the target resource exposes an etag. Query commands must be read-only.

## Model-Backed Objects

`xpod obj` is the CLI surface for model-backed Pod objects. It must not define
business schemas itself. All durable model semantics come from
`@undefineds.co/models`.

### Authority

`@undefineds.co/models` is the authority for RDF classes and predicates,
resource schemas, id/default functions, storage/resource resolution rules,
required fields and field types, secret field markers, writable fields,
validation rules, and interop metadata needed by generic tools.

xpod is responsible only for resolving auth and the effective Pod root, loading
the model catalog from `@undefineds.co/models`, accepting JSON/JSONL/stdin/file
input, validating through the shared model API, reading and writing Pod
resources, and returning stable machine-readable results.

xpod must not invent fallback schemas, hardcode product paths, or maintain a
parallel descriptor table. Existing PodModelDescriptor-style APIs may be
consumed temporarily only as a compatibility catalog exported by
`@undefineds.co/models`; they must be treated as derived interop metadata, not
as an independent schema definition.

### Model Catalog

`xpod obj` consumes a generated or derived model catalog exported by
`@undefineds.co/models`. The catalog is an interop view over the real
schemas/resources. It may include CLI or AI hints, but those hints must not
duplicate or override schema facts.

Allowed catalog content:

- `classUri`
- `resourceKind`
- `fields`
- `predicates`
- `required`
- `secret`
- `array`
- `storage`
- `idDefault`
- `validation`
- `examples`
- `accessNeeds`
- `mergePolicy`

Disallowed catalog content:

- hand-written duplicate business fields
- xpod-local RDF predicates
- xpod-local storage conventions
- xpod-local schema validation

If a model is missing from the catalog, `xpod obj` returns `schema_unknown`
instead of guessing.

### Commands

Required commands:

```bash
xpod obj list
xpod obj describe <class-or-kind>
xpod obj validate --class <uri|kind> --input <json|file|->
xpod obj import --class <uri|kind> --input <json|jsonl|file|->
xpod obj export --class <uri|kind> [--where <json>] [--format json|jsonl] [--out <file>]
```

Rules:

- `obj list` lists model-backed object types from `@undefineds.co/models`.
- `obj describe` prints the model catalog entry for a class or resource kind.
- `obj validate` validates input through `@undefineds.co/models` and returns
  the planned resource target without writing.
- `obj import` imports one or more objects. Batch results must preserve input
  order.
- `obj export` exports objects by model class or resource kind. Filtering must
  use model fields or RDF predicates known to `@undefineds.co/models`.

### Read Discovery

`xpod obj list`, `obj get`, and `obj export` must resolve readable data
locations through the model catalog/resource API before reading object data.
When a model declares Solid Data Interop, ShapeTree, TypeRegistration, or other
registration-backed storage, xpod must use that discovery path and read only
the resolved locations.

The CLI may issue SPARQL, LDP, or raw resource reads as the final transport, but
the set of candidate resources must come from `@undefineds.co/models` and its
underlying discovery/storage rules. A full-Pod SPARQL scan by RDF class is not a
valid fallback unless the model catalog explicitly declares that discovery mode.

If discovery requires a registration and no matching registration can be found,
return `storage_unresolved`. If the requested model is not in the catalog,
return `schema_unknown`.

### Storage Resolution

Storage resolution is delegated to `@undefineds.co/models`:

1. If input provides a canonical base-relative `id`, treat it as exact.
2. Otherwise call the model id/default function.
3. If the model requires an existing Pod registration/type index entry, resolve
   through that registration.
4. If no storage target can be resolved, return `storage_unresolved`.

xpod must not derive paths from class names, resource kinds, or timestamps
unless that logic comes from the model package.

Compatibility implementations that read or write by PodModelDescriptor fields
without resolving the model's current discovery/storage contract are acceptable
only for models whose compatibility catalog explicitly declares that descriptor
mode. They are not compliant for Data Interop-backed resources.

### Object Output Contract

`xpod obj` uses the standard JSON envelope and these stable error codes:

- `auth_required`
- `schema_unknown`
- `storage_unresolved`
- `validation_failed`
- `access_denied`
- `conflict`
- `unsupported_model`
- `write_failed`

Single-item success:

```json
{
  "ok": true,
  "code": "ok",
  "data": {},
  "warnings": []
}
```

Batch success or partial failure uses `code: "batch_completed"` and returns one
result per input item with stable `index`, `ok`, `code`, and resource metadata
when available. Results must preserve input order:

```json
{
  "ok": true,
  "code": "batch_completed",
  "data": [
    {
      "index": 0,
      "ok": true,
      "code": "ok",
      "resource": "settings/providers.ttl#openai"
    },
    {
      "index": 1,
      "ok": false,
      "code": "validation_failed",
      "message": "Field provider is required"
    }
  ],
  "warnings": []
}
```

Errors use the same envelope and never guess missing schemas:

```json
{
  "ok": false,
  "code": "schema_unknown",
  "message": "No model schema is registered for credentialProvider",
  "warnings": []
}
```

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
- Secret resources may use the same model-backed resources as
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
  model-backed objects from xpod's perspective.
- xpod does not provide a curl compatibility surface.

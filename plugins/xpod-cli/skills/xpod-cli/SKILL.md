---
name: xpod-cli
description: Use when designing, implementing, reviewing, testing, or using the Xpod CLI; especially docs/cli-spec.md, raw Pod resource commands, server commands, auth and JSON output contracts, RDF/obj/secret boundaries, marketplace plugin metadata, and release/install validation.
---

# Xpod CLI

Use this skill when work touches the `xpod` command line, its canonical spec,
or agent-facing workflows that depend on the CLI.

## First Checks

- If working inside the xpod repository, read `docs/cli-spec.md` before making
  command-surface decisions.
- If the task touches durable RDF/model semantics, also use the Solid Modeling
  guidance from the `solid-modeling` plugin.
- Prefer the repository's existing TypeScript/yargs command-module patterns and
  Bun scripts.

## Command Boundaries

- Top-level `get`, `put`, `patch`, `delete`, `head`, and `list` are raw Pod
  resource operations only. They must not infer object schemas, business
  models, or product-specific paths.
- Use `xpod server ...` for process/runtime administration:
  `start`, `stop`, `status`, `health`, `logs`, and `config`.
- Do not introduce `xpod run`; foreground startup is
  `xpod server start --foreground`.
- Do not introduce `xpod curl`; the CLI can be curl-like without accepting curl
  compatibility flags.
- Top-level `xpod config` must not mean Pod, AI, or model configuration. If it
  exists temporarily, it may only alias `xpod server config`.
- Use `xpod rdf ...` for graph/resource/subject/triple operations.
- Use `xpod obj ...` for model-backed object transport. Its catalog must be
  exported or derived from `@undefineds.co/models`; xpod must not maintain a
  product descriptor table or invent fallback schemas.
- Use `xpod secret ...` only for secret-safe plans, writes, metadata, and
  revocation. Never print secret values by default.

## Output And Auth

- JSON output uses `{ ok, code, data, warnings }` for success and
  `{ ok: false, code, message, warnings }` for errors.
- Batch output includes per-item `index`, `ok`, and machine-readable `code`.
- In `--json`, CI, or non-interactive mode, missing auth must return
  `code: "auth_required"` and must not open a browser.
- Never print access tokens, refresh tokens, client secrets, cookies, or
  authorization headers unless a human-only debug flag explicitly asks for it.
- Commands that depend on Pod context should report effective WebID, Pod root,
  base IRI, and resource URL in JSON output.

## Implementation Checklist

- Register command modules in `src/cli/index.ts` and keep root help from
  swallowing subcommand help.
- Keep raw resource helpers separate from RDF/model/secret helpers.
- Validate model-backed object work through `@undefineds.co/models` catalog or
  resource APIs; report `schema_unknown` or `storage_unresolved` instead of
  deriving paths or schemas inside xpod.
- Use `drizzle-solid` or shared model APIs for business resources when code is
  in-process. Keep xpod CLI as the external human/script/agent tool surface.
- Update tests with the command-surface change. Existing AI-specific
  `config` tests should not keep the old top-level meaning alive.

## Verification

- Run `bun run build:ts` after TypeScript CLI changes.
- Run focused CLI tests for changed commands and helpers.
- Before claiming completion of substantive implementation work, run
  `bun run test:integration` or report the concrete blocker.
- For marketplace/plugin work, validate `plugins/xpod-cli` with the Codex
  plugin validator and parse both marketplace JSON files.

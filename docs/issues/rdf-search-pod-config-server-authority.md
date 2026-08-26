# RDF search Pod config server-authority removal

## Context

RDF vector reconciliation can re-enter from durable work after the API process restarts. A previous implementation tried to recover by reading Pod AI settings from the server side using only the durable `podRoot`.

## Decision

Xpod must not read user Pod AI settings with server authority, a gateway identity, or a bare Pod root. Pod AI provider credentials are readable only through caller-owned Solid authority that is explicit for the current request or restored from a recorded `authBindingId`.

## Current behavior

`RdfSearchReconciliationWorker` only reuses process-local remembered run contexts. If no authorized context is available for a durable row, the worker marks the row retryable with `auth_context_unavailable` and waits for a later authorized request or task context to wake it.

The removed server-authority resolver is not retained as a fallback or compatibility layer.

## Rejected

- Server-authority SPARQL/QLever reads of `settings/ai` and `settings/credentials`.
- Gateway WebID, ACP grants, service accounts, or invocation tokens for reading user Pods.
- Persisting user embedding API keys outside the Pod so reconciliation can run without caller authority.

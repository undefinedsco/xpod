# RDF search Pod config server-authority gap

## Context

Embedding reconciliation needs to re-enter from a durable Pod-level work item after the API process restarts. At that point there may be no live user request context, but the server is still the storage authority for the Pod it is deriving indexes for.

## Gap

The current drizzle-solid access path is context-oriented and does not expose a narrow server-authority reader for fixed Pod settings graphs. Using it here would either require a synthetic user context or a broader bypass than the indexing job needs.

## Current implementation choice

`RdfSearchPodEmbeddingConfigResolver` reads only canonical Pod settings graphs through the product QLever seam with exact `allowedGraphUrls` / `allowedSourceUrls` scopes. It does not use the TypeScript RDF executor and does not persist raw AI keys outside the user Pod.

## Follow-up

Add a drizzle-solid server-authority read surface for explicitly scoped Pod settings graphs, then replace the SPARQL resolver with that API once it exists.

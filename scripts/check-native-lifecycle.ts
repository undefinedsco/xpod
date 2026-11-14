#!/usr/bin/env bun
/** CSS RDF owner lifecycle gates only; no Gateway, VM, Docker or native build. */
import { spawnSync } from 'node:child_process';

const result = spawnSync('bun', ['run', 'vitest', 'run',
  'tests/storage/SolidRdfDataAccessor.test.ts',
  'tests/storage/rdf/SolidRdfEngineLifecycle.test.ts',
  'tests/storage/rdf/LocalQleverNativeCloseLifecycle.test.ts',
  'tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts',
  '--no-file-parallelism',
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

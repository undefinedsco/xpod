type SmokeTarget = {
  name: string;
  files: string[];
  pattern: string;
};

const smokeTargets: SmokeTarget[] = [
  {
    name: 'models profile/access-control seed',
    files: ['tests/storage/rdf/SolidRdfEngine.test.ts'],
    pattern: 'covers profile, access-control, and control-plane model cases in the benchmark seed',
  },
  {
    name: 'SPARQL ACL/ACR graph access scope',
    files: ['tests/storage/rdf/SolidRdfSparqlEngine.test.ts'],
    pattern: 'filters RDF queries with ACL/ACR graph access scope',
  },
  {
    name: 'PostgreSQL result/materialized cache access scope',
    files: ['tests/storage/rdf/PostgresRdfEngine.test.ts'],
    pattern: [
      'isolates PostgreSQL query result cache entries by query cache scope',
      'isolates and invalidates PostgreSQL query result cache entries by structured access scope',
      'isolates and invalidates PostgreSQL materialized result cache entries by structured access scope',
      'invalidates PostgreSQL result caches by overlapping ACL or ACR access scope',
    ].join('|'),
  },
  {
    name: 'RDF stats cache-scope filters',
    files: ['tests/api/handlers/RdfStatsHandler.test.ts'],
    pattern: 'passes cache scope filters to the stats service',
  },
  {
    name: 'runtime public profile reads',
    files: ['tests/runtime/XpodRuntime.integration.test.ts'],
    pattern: [
      'serves an account-created public profile card without authorization headers',
      'serves a provisioned public profile card without authorization headers',
    ].join('|'),
  },
];

async function runSmokeTarget(target: SmokeTarget): Promise<void> {
  console.log(`\n[rdf-access-smoke] ${target.name}`);
  const child = Bun.spawn([
    process.execPath,
    'x',
    'vitest',
    'run',
    ...target.files,
    '--testNamePattern',
    target.pattern,
  ], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${target.name} failed with exit code ${exitCode}`);
  }
}

for (const target of smokeTargets) {
  await runSmokeTarget(target);
}

console.log('\n[rdf-access-smoke] all gates passed');

import { Pool, type PoolClient } from 'pg';

const RDF_FACT_TABLES = [
  'rdf_quads',
  'rdf_sources',
  'rdf_terms',
] as const;

const RDF_DERIVED_TABLES = [
  'rdf_query_result_cache',
  'rdf3x_stat_g',
  'rdf3x_stat_sp',
  'rdf3x_stat_so',
  'rdf3x_stat_ps',
  'rdf3x_stat_po',
  'rdf3x_stat_os',
  'rdf3x_stat_op',
  'rdf3x_stat_s',
  'rdf3x_stat_p',
  'rdf3x_stat_o',
] as const;

const RDF_METADATA_TABLES = [
  'rdf_index_metadata',
  'rdf3x_metadata',
] as const;

interface CliOptions {
  connectionString: string;
  schema: string;
  execute: boolean;
  includeFacts: boolean;
  confirm?: string;
}

interface ExistingTable {
  name: string;
  count: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: options.connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const plan = await buildResetPlan(client, options);
      printPlan(options, plan);
      if (!options.execute) {
        console.log('\nDry run only. Re-run with --execute and the printed --confirm value to reset data.');
        return;
      }
      assertConfirmed(options);
      await executeReset(client, options, plan);
      console.log('\nPostgreSQL RDF reset completed.');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function parseArgs(args: string[]): CliOptions {
  let connectionString: string | undefined;
  let schema = 'public';
  let execute = false;
  let includeFacts = false;
  let confirm: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--connectionString=')) {
      connectionString = arg.slice('--connectionString='.length);
      continue;
    }
    if (arg.startsWith('--schema=')) {
      schema = arg.slice('--schema='.length);
      continue;
    }
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--includeFacts') {
      includeFacts = true;
      continue;
    }
    if (arg.startsWith('--confirm=')) {
      confirm = arg.slice('--confirm='.length);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!connectionString) {
    throw new Error('--connectionString=... is required');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('--schema must be a simple PostgreSQL identifier');
  }

  return {
    connectionString,
    schema,
    execute,
    includeFacts,
    ...(confirm ? { confirm } : {}),
  };
}

async function buildResetPlan(client: PoolClient, options: CliOptions): Promise<ExistingTable[]> {
  const targetTables = [
    ...RDF_DERIVED_TABLES,
    ...(options.includeFacts ? RDF_FACT_TABLES : []),
    ...RDF_METADATA_TABLES,
  ];
  const existing: ExistingTable[] = [];
  for (const table of targetTables) {
    if (!(await tableExists(client, options.schema, table))) {
      continue;
    }
    existing.push({
      name: table,
      count: await tableCount(client, options.schema, table),
    });
  }
  return existing;
}

async function tableExists(client: PoolClient, schema: string, table: string): Promise<boolean> {
  const rows = await client.query('SELECT to_regclass($1) AS name', [`${schema}.${table}`]);
  return rows.rows[0]?.name !== null && rows.rows[0]?.name !== undefined;
}

async function tableCount(client: PoolClient, schema: string, table: string): Promise<number> {
  const rows = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${qualifiedName(schema, table)}`);
  return Number(rows.rows[0]?.count ?? 0);
}

function printPlan(options: CliOptions, plan: ExistingTable[]): void {
  console.log(`PostgreSQL RDF reset plan (${options.schema})`);
  console.log(`Mode: ${options.includeFacts ? 'facts + derived/cache' : 'derived/cache only'}`);
  console.log(`Execution: ${options.execute ? 'execute' : 'dry-run'}`);
  console.table(plan.map((entry) => ({
    table: entry.name,
    rows: entry.count,
    action: tableAction(entry.name, options.includeFacts),
  })));
  console.log(`\nRequired confirmation: --confirm=${expectedConfirmation(options)}`);
}

function tableAction(table: string, includeFacts: boolean): string {
  if (RDF_DERIVED_TABLES.includes(table as typeof RDF_DERIVED_TABLES[number])) {
    return 'TRUNCATE';
  }
  if (includeFacts && RDF_FACT_TABLES.includes(table as typeof RDF_FACT_TABLES[number])) {
    return 'TRUNCATE';
  }
  if (table === 'rdf_index_metadata') {
    return includeFacts ? 'reset data_version' : 'leave schema_version; no fact reset';
  }
  if (table === 'rdf3x_metadata') {
    return 'reset facts_data_version';
  }
  return 'inspect';
}

function assertConfirmed(options: CliOptions): void {
  const expected = expectedConfirmation(options);
  if (options.confirm !== expected) {
    throw new Error(`Refusing to execute without --confirm=${expected}`);
  }
}

async function executeReset(client: PoolClient, options: CliOptions, plan: ExistingTable[]): Promise<void> {
  await client.query('BEGIN');
  try {
    const existing = new Set(plan.map((entry) => entry.name));
    const truncateTables = [
      ...RDF_DERIVED_TABLES.filter((table) => existing.has(table)),
      ...(options.includeFacts ? RDF_FACT_TABLES.filter((table) => existing.has(table)) : []),
    ];
    if (truncateTables.length > 0) {
      await client.query(`TRUNCATE TABLE ${truncateTables.map((table) => qualifiedName(options.schema, table)).join(', ')} RESTART IDENTITY`);
    }
    if (existing.has('rdf3x_metadata')) {
      await client.query(`
        INSERT INTO ${qualifiedName(options.schema, 'rdf3x_metadata')} (key, value)
        VALUES ('facts_data_version', '0')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `);
    }
    if (options.includeFacts && existing.has('rdf_index_metadata')) {
      await client.query(`
        INSERT INTO ${qualifiedName(options.schema, 'rdf_index_metadata')} (key, value)
        VALUES ('data_version', '0')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function expectedConfirmation(options: CliOptions): string {
  return options.includeFacts ? 'RESET_XPOD_RDF_FACTS' : 'RESET_XPOD_RDF_DERIVED';
}

function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function printHelp(): void {
  console.log(`
Usage:
  bun scripts/reset-postgres-rdf-index.ts --connectionString=postgres://... [options]

Options:
  --schema=public       PostgreSQL schema containing xpod RDF tables.
  --execute             Execute the reset. Without this flag the script is dry-run only.
  --includeFacts        Also clear rdf_quads/rdf_sources/rdf_terms and reset facts data_version.
  --confirm=VALUE       Required with --execute. Use the value printed by dry-run.

Modes:
  Derived/cache only confirmation: --confirm=RESET_XPOD_RDF_DERIVED
  Facts reset confirmation:        --confirm=RESET_XPOD_RDF_FACTS

The script only targets xpod RDF facts, RDF-3X derived stats, and RDF query
cache tables. It never touches identity, auth, quota, billing, AI gateway, or
blob/object storage tables.
`.trim());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

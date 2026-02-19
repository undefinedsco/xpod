/**
 * xpod import — Import data from databases or files into a Solid Pod.
 *
 * Supports:
 *   --from-db <connection-string>   Import from PostgreSQL or SQLite
 *   --from-file <path>              Import from CSV/JSON/Turtle file
 *   --from-pod <url>                Import from another Pod (future)
 */

import type { CommandModule } from 'yargs';
import { readFileSync } from 'fs';
import { parseMappingFile } from '../lib/import/mapping-parser';
import { buildSql } from '../lib/import/sql-builder';
import { generateTriplesForRow, extractSubjectId, buildPrefixHeader } from '../lib/import/triple-generator';
import { connectDb, detectDbType } from '../lib/import/db-connector';
import { resolvePod, putTurtle } from '../lib/import/pod-writer';
import type { TriplesMap, Row, Granularity } from '../lib/import/types';

interface ImportArgs {
  'from-db'?: string;
  'from-file'?: string;
  'from-pod'?: string;
  mapping?: string;
  to: string;
  url: string;
  email?: string;
  password?: string;
  granularity: Granularity;
  'dry-run': boolean;
  'base-iri'?: string;
  format?: string;
}

// ============================================
// File import helpers
// ============================================

function parseCsvRows(content: string): Row[] {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    const row: Row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseJsonRows(content: string): Row[] {
  const data = JSON.parse(content);
  if (Array.isArray(data)) return data as Row[];
  return [data as Row];
}

function loadFileRows(filePath: string, format?: string): Row[] {
  const content = readFileSync(filePath, 'utf-8');
  const ext = format ?? filePath.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    case 'csv':
      return parseCsvRows(content);
    case 'json':
      return parseJsonRows(content);
    case 'ttl':
    case 'turtle':
      // Turtle files are passed through directly, no row parsing
      throw new Error('Turtle files do not need mapping — use PUT directly or omit --mapping');
    default:
      throw new Error(`Unsupported file format: ${ext}. Use --format csv|json|turtle`);
  }
}

// ============================================
// Pipeline: from-db
// ============================================

async function importFromDb(argv: ImportArgs): Promise<void> {
  if (!argv.mapping) {
    console.error('--mapping is required for database import.');
    process.exit(1);
  }

  const maps = parseMappingFile(argv.mapping);
  if (maps.length === 0) {
    console.error('No TriplesMap found in mapping file.');
    process.exit(1);
  }

  const connectionString = argv['from-db']!;
  const dbType = detectDbType(connectionString);
  const db = await connectDb({ type: dbType, connectionString });

  try {
    await processTriplesMaps(maps, db.query.bind(db), argv);
  } finally {
    await db.close();
  }
}

// ============================================
// Pipeline: from-file
// ============================================

async function importFromFile(argv: ImportArgs): Promise<void> {
  const filePath = argv['from-file']!;
  const ext = argv.format ?? filePath.split('.').pop()?.toLowerCase() ?? '';

  // Turtle pass-through: no mapping needed
  if (ext === 'ttl' || ext === 'turtle') {
    const content = readFileSync(filePath, 'utf-8');
    if (argv['dry-run']) {
      process.stdout.write(content);
      return;
    }
    const pod = await authenticateAndResolvePod(argv);
    await putTurtle(pod, argv.to, content);
    console.log(`Uploaded ${filePath} → ${argv.to}`);
    return;
  }

  if (!argv.mapping) {
    console.error('--mapping is required for CSV/JSON import.');
    process.exit(1);
  }

  const maps = parseMappingFile(argv.mapping);
  if (maps.length === 0) {
    console.error('No TriplesMap found in mapping file.');
    process.exit(1);
  }

  const rows = loadFileRows(filePath, argv.format);

  // Create a fake query function that yields all rows
  async function* fakeQuery(): AsyncIterable<Row> {
    for (const row of rows) {
      yield row;
    }
  }

  await processTriplesMaps(maps, () => fakeQuery(), argv);
}

// ============================================
// Shared pipeline logic
// ============================================

async function authenticateAndResolvePod(argv: ImportArgs) {
  if (!argv.email || !argv.password) {
    console.error('--email and --password are required for Pod write.');
    process.exit(1);
  }
  return resolvePod({
    baseUrl: argv.url,
    email: argv.email,
    password: argv.password,
  });
}

async function processTriplesMaps(
  maps: TriplesMap[],
  queryFn: (sql: string) => AsyncIterable<Row>,
  argv: ImportArgs,
): Promise<void> {
  const prefixHeader = buildPrefixHeader(maps);
  const isDryRun = argv['dry-run'];
  const granularity = argv.granularity;

  let pod: Awaited<ReturnType<typeof resolvePod>> | null = null;
  if (!isDryRun) {
    pod = await authenticateAndResolvePod(argv);
  }

  for (const map of maps) {
    const sql = buildSql(map);
    if (isDryRun) {
      console.error(`# SQL for ${map.id}: ${sql}`);
    }

    const turtleChunks: string[] = [];
    let rowCount = 0;

    for await (const row of queryFn(sql)) {
      const triples = generateTriplesForRow(map, row);
      rowCount++;

      if (granularity === 'per-row') {
        const subjectId = extractSubjectId(map, row);
        const fullTurtle = `${prefixHeader}\n\n${triples}\n`;

        if (isDryRun) {
          console.error(`\n# --- ${subjectId}.ttl ---`);
          process.stdout.write(fullTurtle);
        } else {
          const targetPath = argv.to.replace(/\/$/, '') + `/${subjectId}.ttl`;
          await putTurtle(pod!, targetPath, fullTurtle);
        }
      } else {
        turtleChunks.push(triples);
      }

      if (rowCount % 100 === 0) {
        console.error(`  processed ${rowCount} rows...`);
      }
    }

    // per-table: write all triples as one resource
    if (granularity === 'per-table' && turtleChunks.length > 0) {
      const fullTurtle = `${prefixHeader}\n\n${turtleChunks.join('\n\n')}\n`;

      if (isDryRun) {
        process.stdout.write(fullTurtle);
      } else {
        await putTurtle(pod!, argv.to, fullTurtle);
      }
    }

    console.error(`  ${map.id}: ${rowCount} rows processed.`);
  }
}

// ============================================
// Command definition
// ============================================

export const importCommand: CommandModule<object, ImportArgs> = {
  command: 'import',
  describe: 'Import data into a Solid Pod',
  builder: (yargs) =>
    yargs
      .option('from-db', {
        type: 'string',
        description: 'Database connection string (postgres:// or SQLite file path)',
        conflicts: ['from-file', 'from-pod'],
      })
      .option('from-file', {
        type: 'string',
        description: 'File path to import (CSV, JSON, or Turtle)',
        conflicts: ['from-db', 'from-pod'],
      })
      .option('from-pod', {
        type: 'string',
        description: 'Source Pod URL to import from',
        conflicts: ['from-db', 'from-file'],
      })
      .option('mapping', {
        alias: 'm',
        type: 'string',
        description: 'JSON-LD mapping file path (R2RML + udfs extensions)',
      })
      .option('to', {
        alias: 't',
        type: 'string',
        description: 'Target path inside the Pod',
        demandOption: true,
      })
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server base URL',
        default: process.env.CSS_BASE_URL || 'http://localhost:3000',
      })
      .option('email', { type: 'string', description: 'Account email' })
      .option('password', { type: 'string', description: 'Account password' })
      .option('granularity', {
        alias: 'g',
        type: 'string',
        choices: ['per-table', 'per-row'] as const,
        default: 'per-table' as Granularity,
        description: 'Write granularity: one file per table or per row',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        description: 'Parse and generate Turtle without writing to Pod',
      })
      .option('base-iri', {
        type: 'string',
        description: 'Base IRI for generated triples',
      })
      .option('format', {
        type: 'string',
        choices: ['csv', 'json', 'turtle'] as const,
        description: 'File format (auto-detected from extension if omitted)',
      })
      .check((argv) => {
        if (!argv['from-db'] && !argv['from-file'] && !argv['from-pod']) {
          throw new Error('Specify one of --from-db, --from-file, or --from-pod');
        }
        return true;
      }) as any,
  handler: async (argv) => {
    try {
      if (argv['from-db']) {
        await importFromDb(argv);
      } else if (argv['from-file']) {
        await importFromFile(argv);
      } else if (argv['from-pod']) {
        console.error('--from-pod is not yet implemented. Coming in a future release.');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Import failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
};

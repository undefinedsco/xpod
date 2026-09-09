import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

export type GenerateParityFixtureInput = {
  outputDirectory: string;
  targetFacts: number;
};

export type ParityFixturePublishSeam = {
  publishRename?: (source: string, destination: string) => Promise<void>;
};

export type ParityFixtureManifest = {
  csvDialect: string;
  factCount: number;
  graphCount: number;
  files: Record<'facts.nq' | 'rdf_terms.csv' | 'rdf_quads.csv', { sha256: string }>;
};

type RdfTerm =
  | { kind: 'iri'; value: string }
  | { datatype?: string; kind: 'literal'; language?: string; value: string };

class HashedWriter {
  readonly hash = createHash('sha256');
  readonly stream: WriteStream;
  private failure: unknown;
  private finished = false;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: 'utf8' });
    this.stream.on('error', (error) => {
      this.failure ??= error;
    });
  }

  async write(chunk: string): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    this.hash.update(chunk);
    if (!this.stream.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.stream.off('drain', onDrain);
          this.stream.off('error', onError);
        };
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
      });
    }
  }

  async close(): Promise<string> {
    this.stream.end();
    await finished(this.stream);
    this.finished = true;
    return this.hash.digest('hex');
  }

  destroy(): void {
    if (!this.finished && !this.stream.destroyed) {
      this.stream.destroy();
    }
  }
}

class TermDictionary {
  private readonly ids = new Map<string, number>();
  private nextId = 1;

  constructor(private readonly writer: HashedWriter) {}

  async idFor(term: RdfTerm): Promise<number> {
    const key = JSON.stringify(term);
    const existing = this.ids.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const id = this.nextId;
    this.nextId += 1;
    this.ids.set(key, id);
    await this.writer.write(formatTermCsvRow(id, term));
    return id;
  }
}

function assertValidTargetFacts(targetFacts: number): void {
  if (!Number.isInteger(targetFacts) || targetFacts < 0) {
    throw new Error(`targetFacts must be a non-negative integer, got ${targetFacts}`);
  }
}

function csvField(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatCsvRow(fields: (string | number)[]): string {
  return `${fields.map(csvField).join(',')}\n`;
}

function escapeNQuadIri(value: string): string {
  return value.replace(/[\u0000-\u0020<>"{}|^`\\]/g, (char) => {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error(`unable to encode IRI character ${char}`);
    }
    return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

function escapeNQuadLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/"/g, '\\"');
}

function formatNQuadTerm(term: RdfTerm): string {
  if (term.kind === 'iri') {
    return `<${escapeNQuadIri(term.value)}>`;
  }

  const literal = `"${escapeNQuadLiteral(term.value)}"`;
  if (term.language) {
    return `${literal}@${term.language}`;
  }
  if (term.datatype) {
    return `${literal}^^<${escapeNQuadIri(term.datatype)}>`;
  }
  return literal;
}

function formatTermCsvRow(id: number, term: RdfTerm): string {
  if (term.kind === 'iri') {
    return formatCsvRow([id, term.kind, term.value, '', '']);
  }
  return formatCsvRow([id, term.kind, term.value, term.language ?? '', term.datatype ?? '']);
}

function subjectFor(index: number): RdfTerm {
  if (index % 997 === 0) {
    return { kind: 'iri', value: `https://example.test/entity/needs%20%22escaping%22/${index}` };
  }
  return { kind: 'iri', value: `https://example.test/entity/${index}` };
}

function predicateFor(phase: number): RdfTerm {
  const predicates = [
    'https://schema.example.test/name',
    'https://schema.example.test/score',
    'https://schema.example.test/related',
  ];
  return { kind: 'iri', value: predicates[phase] };
}

function objectFor(subjectIndex: number, phase: number): RdfTerm {
  if (phase === 1) {
    return {
      kind: 'literal',
      value: String(subjectIndex),
    };
  }
  if (phase === 2) {
    return subjectFor(subjectIndex + 1);
  }
  if (subjectIndex % 997 === 0) {
    return {
      kind: 'literal',
      language: 'en',
      value: `quoted "literal", subject ${subjectIndex}\nsecond line`,
    };
  }
  return { kind: 'literal', language: 'en', value: `label ${subjectIndex}` };
}

function graphFor(subjectIndex: number): RdfTerm {
  return { kind: 'iri', value: `https://example.test/graph/${subjectIndex % 8}` };
}

const fixtureNames = ['facts.nq', 'rdf_terms.csv', 'rdf_quads.csv', 'manifest.json'] as const;
const dataFileNames = ['facts.nq', 'rdf_terms.csv', 'rdf_quads.csv'] as const;

async function isExistingPublishableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile()) {
      const error = new Error(`cannot replace non-file fixture path: ${filePath}`) as NodeJS.ErrnoException;
      error.code = stats.isDirectory() ? 'EISDIR' : 'EINVAL';
      throw error;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function generateParityFixture(
  input: GenerateParityFixtureInput,
  seam: ParityFixturePublishSeam = {},
): Promise<ParityFixtureManifest> {
  assertValidTargetFacts(input.targetFacts);
  await mkdir(input.outputDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(input.outputDirectory, '.parity-fixture-'));
  const writers: HashedWriter[] = [];
  let originalError: unknown;
  let preserveStaging = false;

  try {
    const facts = new HashedWriter(path.join(stagingDirectory, 'facts.nq'));
    writers.push(facts);
    const terms = new HashedWriter(path.join(stagingDirectory, 'rdf_terms.csv'));
    writers.push(terms);
    const quads = new HashedWriter(path.join(stagingDirectory, 'rdf_quads.csv'));
    writers.push(quads);
    const termDictionary = new TermDictionary(terms);
    const graphIds = new Set<number>();

    await terms.write(formatCsvRow(['id', 'kind', 'value', 'language', 'datatype']));
    await quads.write(formatCsvRow(['subject_id', 'predicate_id', 'object_id', 'graph_id']));

    for (let index = 0; index < input.targetFacts; index += 1) {
      const subjectIndex = Math.floor(index / 3);
      const phase = index % 3;
      const subject = subjectFor(subjectIndex);
      const predicate = predicateFor(phase);
      const object = objectFor(subjectIndex, phase);
      const graph = graphFor(subjectIndex);

      const subjectId = await termDictionary.idFor(subject);
      const predicateId = await termDictionary.idFor(predicate);
      const objectId = await termDictionary.idFor(object);
      const graphId = await termDictionary.idFor(graph);
      graphIds.add(graphId);

      await facts.write(`${formatNQuadTerm(subject)} ${formatNQuadTerm(predicate)} ${formatNQuadTerm(object)} ${formatNQuadTerm(graph)} .\n`);
      await quads.write(formatCsvRow([subjectId, predicateId, objectId, graphId]));
    }

    const factsHash = await facts.close();
    const termsHash = await terms.close();
    const quadsHash = await quads.close();
    const manifest: ParityFixtureManifest = {
      csvDialect: 'RFC4180 CSV with header; consumable by PostgreSQL COPY ... WITH (FORMAT csv, HEADER true)',
      factCount: input.targetFacts,
      graphCount: graphIds.size,
      files: {
        'facts.nq': { sha256: factsHash },
        'rdf_terms.csv': { sha256: termsHash },
        'rdf_quads.csv': { sha256: quadsHash },
      },
    };

    await writeFile(
      path.join(stagingDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const existingFiles = new Set<string>();
    for (const name of fixtureNames) {
      const finalPath = path.join(input.outputDirectory, name);
      if (await isExistingPublishableFile(finalPath)) {
        existingFiles.add(name);
      }
    }
    for (const name of existingFiles) {
      await copyFile(
        path.join(input.outputDirectory, name),
        path.join(stagingDirectory, `.backup-${name}`),
      );
    }

    const publishRename = seam.publishRename ?? rename;
    try {
      for (const name of dataFileNames) {
        await publishRename(
          path.join(stagingDirectory, name),
          path.join(input.outputDirectory, name),
        );
      }
      await publishRename(
        path.join(stagingDirectory, 'manifest.json'),
        path.join(input.outputDirectory, 'manifest.json'),
      );
    } catch (publishError) {
      const rollbackErrors: unknown[] = [];
      for (const name of [...fixtureNames].reverse()) {
        try {
          const finalPath = path.join(input.outputDirectory, name);
          if (existingFiles.has(name)) {
            await rename(path.join(stagingDirectory, `.backup-${name}`), finalPath);
          } else {
            await rm(finalPath, { force: true });
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        preserveStaging = true;
        throw new AggregateError(
          [publishError, ...rollbackErrors],
          'fixture publication failed and rollback was incomplete',
        );
      }
      throw publishError;
    }
    return manifest;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    for (const writer of writers) {
      writer.destroy();
    }
    if (!preserveStaging) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        if (originalError === undefined) {
          throw cleanupError;
        }
      }
    }
  }
}

function parseCliArguments(argv: string[]): GenerateParityFixtureInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--target-facts' && flag !== '--output-dir') {
      throw new Error(`unknown argument: ${flag ?? ''}`);
    }
    if (values.has(flag)) {
      throw new Error(`duplicate argument: ${flag}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag, value);
  }

  const targetFactsText = values.get('--target-facts');
  const outputDirectory = values.get('--output-dir');
  if (targetFactsText === undefined) {
    throw new Error('missing required argument: --target-facts');
  }
  if (outputDirectory === undefined) {
    throw new Error('missing required argument: --output-dir');
  }
  if (!/^[1-9][0-9]*$/.test(targetFactsText)) {
    throw new Error('--target-facts must be a positive decimal integer');
  }
  const targetFacts = Number(targetFactsText);
  if (!Number.isSafeInteger(targetFacts)) {
    throw new Error('--target-facts must be a safe positive integer');
  }
  if (outputDirectory.trim().length === 0 || outputDirectory.includes('\0')) {
    throw new Error('--output-dir must be a non-empty valid path');
  }
  return { outputDirectory, targetFacts };
}

async function runParityFixtureCli(argv: string[]): Promise<void> {
  const manifest = await generateParityFixture(parseCliArguments(argv));
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

if (import.meta.main) {
  try {
    await runParityFixtureCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { generateParityFixture } from '../scripts/generate-parity-fixture';

type CsvRecord = string[];

const generatorScript = path.resolve(__dirname, '../scripts/generate-parity-fixture.ts');

async function runGeneratorCli(args: string[]): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  const child = spawn(process.execPath, [generatorScript, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, stderr, stdout };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBytes(root: string, name: string): Buffer {
  return readFileSync(path.join(root, name));
}

function parseCsv(content: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  expect(inQuotes).toBe(false);
  expect(field).toBe('');
  expect(row).toEqual([]);
  return rows;
}

function escapeNQuadIri(value: string): string {
  return value.replace(/[\u0000-\u0020<>"{}|^`\\]/g, (char) => {
    const codePoint = char.codePointAt(0);
    expect(codePoint).toBeDefined();
    return `\\u${codePoint!.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

function termToNQuad(term: CsvRecord): string {
  const [id, kind, value, language, datatype] = term;
  expect(id).toMatch(/^[1-9][0-9]*$/);
  if (kind === 'iri') {
    expect(language).toBe('');
    expect(datatype).toBe('');
    return `<${escapeNQuadIri(value)}>`;
  }
  if (kind === 'literal') {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/"/g, '\\"');
    if (language) return `"${escaped}"@${language}`;
    if (datatype) return `"${escaped}"^^<${datatype}>`;
    return `"${escaped}"`;
  }
  throw new Error(`unsupported RDF term kind ${kind}`);
}

async function withTempFixture<T>(
  name: string,
  callback: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('parity fixture generator', () => {
  it('emits parser-safe percent-encoded IRIs for special fixture subjects', async () => {
    await withTempFixture('xpod-parity-fixture-iri-', async (root) => {
      await generateParityFixture({ outputDirectory: root, targetFacts: 1 });

      const facts = readFileSync(path.join(root, 'facts.nq'), 'utf8');
      const terms = readFileSync(path.join(root, 'rdf_terms.csv'), 'utf8');
      expect(facts).toContain('<https://example.test/entity/needs%20%22escaping%22/0>');
      expect(terms).toContain('https://example.test/entity/needs%20%22escaping%22/0');
      expect(facts).not.toContain('\\u0020');
    });
  });

  it('runs as a real CLI and prints the generated manifest JSON', async () => {
    await withTempFixture('xpod-parity-fixture-cli-', async (root) => {
      const outputDirectory = path.join(root, 'fixture');
      const result = await runGeneratorCli([
        '--target-facts',
        '20000',
        '--output-dir',
        outputDirectory,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const stdoutManifest = JSON.parse(result.stdout);
      const diskManifest = JSON.parse(readFileSync(path.join(outputDirectory, 'manifest.json'), 'utf8'));
      expect(stdoutManifest).toEqual(diskManifest);
      expect(stdoutManifest.factCount).toBe(20_000);
      expect((await readdir(outputDirectory)).sort()).toEqual([
        'facts.nq',
        'manifest.json',
        'rdf_quads.csv',
        'rdf_terms.csv',
      ]);
    });
  });

  it('rejects invalid CLI arguments with a non-zero exit', async () => {
    await withTempFixture('xpod-parity-fixture-cli-errors-', async (root) => {
      const invalidArguments = [
        ['--target-facts', '0', '--output-dir', path.join(root, 'zero')],
        ['--target-facts', '20k', '--output-dir', path.join(root, 'text')],
        ['--target-facts', '10', '--output-dir'],
        ['--target-facts', '10', '--output-dir', path.join(root, 'unknown'), '--extra'],
      ];

      for (const args of invalidArguments) {
        const result = await runGeneratorCli(args);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr.length).toBeGreaterThan(0);
      }
      expect(await readdir(root)).toEqual([]);
    });
  });

  it('generates deterministic 20k fact fixtures with matching byte hashes', async () => {
    await withTempFixture('xpod-parity-fixture-a-', async (firstRoot) => {
      await withTempFixture('xpod-parity-fixture-b-', async (secondRoot) => {
        const firstManifest = await generateParityFixture({
          outputDirectory: firstRoot,
          targetFacts: 20_000,
        });
        const secondManifest = await generateParityFixture({
          outputDirectory: secondRoot,
          targetFacts: 20_000,
        });

        expect(firstManifest).toEqual(secondManifest);
        for (const name of ['facts.nq', 'rdf_terms.csv', 'rdf_quads.csv', 'manifest.json']) {
          expect(existsSync(path.join(firstRoot, name))).toBe(true);
          expect(readBytes(firstRoot, name)).toEqual(readBytes(secondRoot, name));
        }

        const quadRows = parseCsv(readFileSync(path.join(firstRoot, 'rdf_quads.csv'), 'utf8'));
        expect(quadRows.shift()).toEqual(['subject_id', 'predicate_id', 'object_id', 'graph_id']);
        const uniqueGraphIds = new Set(quadRows.map((row) => row[3]));

        expect(firstManifest.factCount).toBe(20_000);
        expect(firstManifest.graphCount).toBe(uniqueGraphIds.size);

        expect(firstManifest.files['facts.nq'].sha256).toBe(sha256(readBytes(firstRoot, 'facts.nq')));
        expect(firstManifest.files['rdf_terms.csv'].sha256).toBe(sha256(readBytes(firstRoot, 'rdf_terms.csv')));
        expect(firstManifest.files['rdf_quads.csv'].sha256).toBe(sha256(readBytes(firstRoot, 'rdf_quads.csv')));
      });
    });
  });

  it('uses term-stable plain score literals in the cross-engine benchmark fixture', async () => {
    await withTempFixture('xpod-parity-integer-', async (root) => {
      await generateParityFixture({ outputDirectory: root, targetFacts: 20_000 });

      const terms = parseCsv(readFileSync(path.join(root, 'rdf_terms.csv'), 'utf8'));
      const score = terms.find(([, kind, value]) => kind === 'literal' && value === '42');
      expect(score).toEqual([
        expect.any(String),
        'literal',
        '42',
        '',
        '',
      ]);
    });
  });

  it('maps every CSV quad to exactly one named-graph N-Quad without orphan terms', async () => {
    await withTempFixture('xpod-parity-fixture-semantic-', async (root) => {
      await generateParityFixture({ outputDirectory: root, targetFacts: 20_000 });

      const termRows = parseCsv(readFileSync(path.join(root, 'rdf_terms.csv'), 'utf8'));
      const quadRows = parseCsv(readFileSync(path.join(root, 'rdf_quads.csv'), 'utf8'));
      expect(termRows.shift()).toEqual(['id', 'kind', 'value', 'language', 'datatype']);
      expect(quadRows.shift()).toEqual(['subject_id', 'predicate_id', 'object_id', 'graph_id']);

      const terms = new Map<string, string>();
      const termIds = new Map<string, string>();
      let sawPercentEncodedIriFixture = false;
      let sawEscapedLiteralFixture = false;
      for (const row of termRows) {
        expect(row).toHaveLength(5);
        const [id] = row;
        expect(terms.has(id)).toBe(false);
        terms.set(id, termToNQuad(row));
        termIds.set(`${row[1]}:${row[2]}`, id);
        if (row[1] === 'iri' && row[2].includes('%22')) {
          sawPercentEncodedIriFixture = true;
        }
        if (row[1] === 'literal' && row[2].includes('\n') && row[2].includes('"')) {
          sawEscapedLiteralFixture = true;
        }
      }
      expect(sawPercentEncodedIriFixture).toBe(true);
      expect(sawEscapedLiteralFixture).toBe(true);

      const nqLines = readFileSync(path.join(root, 'facts.nq'), 'utf8').trimEnd().split('\n');
      expect(quadRows).toHaveLength(nqLines.length);
      const nquads = new Map<string, number>();
      for (const line of nqLines) {
        expect(line).toMatch(/^<[^>]+> <[^>]+> .+ <[^>]+> \.$/);
        nquads.set(line, (nquads.get(line) ?? 0) + 1);
      }

      const referencedTermIds = new Set<string>();
      for (const row of quadRows) {
        expect(row).toHaveLength(4);
        const [subjectId, predicateId, objectId, graphId] = row;
        for (const id of row) {
          expect(terms.has(id), `missing term id ${id}`).toBe(true);
          referencedTermIds.add(id);
        }
        const line = `${terms.get(subjectId)} ${terms.get(predicateId)} ${terms.get(objectId)} ${terms.get(graphId)} .`;
        expect(nquads.get(line), line).toBe(1);
      }

      expect(referencedTermIds.size).toBe(terms.size);

      const iriId = (value: string): string => {
        const id = termIds.get(`iri:${value}`);
        expect(id, `missing fixture IRI ${value}`).toBeDefined();
        return id!;
      };
      const nameId = iriId('https://schema.example.test/name');
      const scoreId = iriId('https://schema.example.test/score');
      const relatedId = iriId('https://schema.example.test/related');
      const pointSubjectId = iriId('https://example.test/entity/42');
      const graph2Id = iriId('https://example.test/graph/2');
      const graph3Id = iriId('https://example.test/graph/3');

      expect(quadRows.some(([subjectId]) => subjectId === pointSubjectId)).toBe(true);
      expect(quadRows.filter(([, , , graphId]) => graphId === graph3Id).length).toBeGreaterThanOrEqual(100);

      const relatedBySubject = new Map<string, string>();
      const namedSubjects = new Set<string>();
      const scoredInGraph2 = new Set<string>();
      const namedInGraph2 = new Set<string>();
      const graphFactCounts = new Map<string, number>();
      const distinctSubjects = new Set<string>();
      for (const [subjectId, predicateId, objectId, graphId] of quadRows) {
        distinctSubjects.add(subjectId);
        graphFactCounts.set(graphId, (graphFactCounts.get(graphId) ?? 0) + 1);
        if (predicateId === relatedId) relatedBySubject.set(subjectId, objectId);
        if (predicateId === nameId) namedSubjects.add(subjectId);
        if (graphId === graph2Id && predicateId === scoreId) scoredInGraph2.add(subjectId);
        if (graphId === graph2Id && predicateId === nameId) namedInGraph2.add(subjectId);
      }

      const chainMatches = (relatedEdges: number): number => {
        let matches = 0;
        for (const start of relatedBySubject.keys()) {
          let current: string | undefined = start;
          for (let hop = 0; hop < relatedEdges; hop += 1) {
            current = current === undefined ? undefined : relatedBySubject.get(current);
          }
          if (current !== undefined && namedSubjects.has(current)) matches += 1;
        }
        return matches;
      };

      expect(chainMatches(1)).toBeGreaterThanOrEqual(100);
      expect(chainMatches(3)).toBeGreaterThanOrEqual(100);
      expect(chainMatches(7)).toBeGreaterThanOrEqual(100);
      expect(graphFactCounts.size).toBe(8);
      expect([...graphFactCounts.values()].every((count) => count >= 100)).toBe(true);
      expect(distinctSubjects.size).toBeGreaterThanOrEqual(1_000);
      expect([...scoredInGraph2].filter((subjectId) => namedInGraph2.has(subjectId)).length).toBeGreaterThanOrEqual(100);
    });
  });

  it('preserves a pre-existing fixture when publication fails', async () => {
    await withTempFixture('xpod-parity-fixture-failure-', async (root) => {
      const oldFacts = 'old facts\n';
      const oldTerms = 'old terms\n';
      const oldManifest = '{"release":"old"}\n';
      await writeFile(path.join(root, 'facts.nq'), oldFacts);
      await writeFile(path.join(root, 'rdf_terms.csv'), oldTerms);
      await mkdir(path.join(root, 'rdf_quads.csv'));
      await writeFile(path.join(root, 'rdf_quads.csv', 'keep'), 'old quads\n');
      await writeFile(path.join(root, 'manifest.json'), oldManifest);
      const originalEntries = await readdir(root);

      let failure: unknown;
      try {
        await generateParityFixture({ outputDirectory: root, targetFacts: 10 });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as NodeJS.ErrnoException).code).toBe('EISDIR');
      expect(readFileSync(path.join(root, 'facts.nq'), 'utf8')).toBe(oldFacts);
      expect(readFileSync(path.join(root, 'rdf_terms.csv'), 'utf8')).toBe(oldTerms);
      expect(readFileSync(path.join(root, 'rdf_quads.csv', 'keep'), 'utf8')).toBe('old quads\n');
      expect(readFileSync(path.join(root, 'manifest.json'), 'utf8')).toBe(oldManifest);
      expect(await readdir(root)).toEqual(originalEntries);
    });
  });

  it('rolls back every file when a data publish rename fails after the first rename', async () => {
    await withTempFixture('xpod-parity-fixture-rollback-', async (root) => {
      const originalFiles = new Map([
        ['facts.nq', Buffer.from('old facts\n')],
        ['rdf_terms.csv', Buffer.from('old terms\n')],
        ['rdf_quads.csv', Buffer.from('old quads\n')],
        ['manifest.json', Buffer.from('{"release":"old"}\n')],
      ]);
      for (const [name, bytes] of originalFiles) {
        await writeFile(path.join(root, name), bytes);
      }
      const originalEntries = await readdir(root);
      const injectedFailure = new Error('injected second publish rename failure');
      let publishRenameCount = 0;

      let failure: unknown;
      try {
        await generateParityFixture(
          { outputDirectory: root, targetFacts: 10 },
          {
            publishRename: async (source, destination) => {
              publishRenameCount += 1;
              if (publishRenameCount === 2) {
                throw injectedFailure;
              }
              await rename(source, destination);
            },
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(publishRenameCount).toBe(2);
      expect(failure).toBe(injectedFailure);
      for (const [name, bytes] of originalFiles) {
        expect(readBytes(root, name)).toEqual(bytes);
      }
      expect(await readdir(root)).toEqual(originalEntries);
    });
  });
});

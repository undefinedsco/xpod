import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const privatePostgresMarkers = [
  'cloud.enterprise',
  'xpod-rdf-components',
];

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  }));
  return files.flat().filter((file) => /\.(?:ts|json|md)$/.test(file));
}

describe('native RDF product boundary', () => {
  it('keeps deployment-specific PostgreSQL native implementation assets outside the public tree', async () => {
    expect(existsSync(path.join(repoRoot, 'native/postgres'))).toBe(false);
    expect(existsSync(path.join(repoRoot, 'config/cloud.enterprise.json'))).toBe(false);

    const packageJson = (await readFile(path.join(repoRoot, 'package.json'), 'utf8')).toLowerCase();
    for (const marker of privatePostgresMarkers) {
      expect(packageJson).not.toContain(marker);
    }
  });

  it('keeps the public runtime free of private PostgreSQL native implementation bindings', async () => {
    const files = (
      await Promise.all(['src', 'config', 'scripts'].map((root) =>
        sourceFiles(path.join(repoRoot, root))))
    ).flat();
    for (const file of files) {
      const source = (await readFile(file, 'utf8')).toLowerCase();
      for (const marker of privatePostgresMarkers) {
        expect(source, path.relative(repoRoot, file)).not.toContain(marker);
      }
    }

    const postgresEngine = await readFile(
      path.join(repoRoot, 'src/storage/rdf/PostgresRdfEngine.ts'),
      'utf8',
    );
    expect(postgresEngine).toContain('xpod_rdf.native_sparql_capabilities()');
    expect(postgresEngine).toContain('xpod_rdf.native_sparql_query($1, $2::jsonb)');
  });
});

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const implementationMarker = ['q', 'lever'].join('');

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  }));
  return files.flat().filter((file) => /\.(?:ts|json|md)$/.test(file));
}

describe('native RDF product boundary', () => {
  it('keeps deployment-specific native implementation assets outside the public tree', async () => {
    expect(existsSync(path.join(repoRoot, 'native/postgres'))).toBe(false);
    expect(existsSync(path.join(repoRoot, 'config/cloud.enterprise.json'))).toBe(false);

    const packageJson = (await readFile(path.join(repoRoot, 'package.json'), 'utf8')).toLowerCase();
    expect(packageJson).not.toContain(implementationMarker);
    expect(packageJson).not.toContain('cloud:enterprise');
  });

  it('keeps the public runtime on a vendor-neutral native SPARQL ABI', async () => {
    const files = (
      await Promise.all(['src', 'config', 'docs', 'scripts'].map((root) =>
        sourceFiles(path.join(repoRoot, root))))
    ).flat();
    for (const file of files) {
      const source = (await readFile(file, 'utf8')).toLowerCase();
      expect(source, path.relative(repoRoot, file)).not.toContain(implementationMarker);
      expect(source, path.relative(repoRoot, file)).not.toContain('cloud.enterprise');
    }

    const postgresEngine = await readFile(
      path.join(repoRoot, 'src/storage/rdf/PostgresRdfEngine.ts'),
      'utf8',
    );
    expect(postgresEngine).toContain('xpod_rdf.native_sparql_capabilities()');
    expect(postgresEngine).toContain('xpod_rdf.native_sparql_query($1, $2::jsonb)');
  });
});

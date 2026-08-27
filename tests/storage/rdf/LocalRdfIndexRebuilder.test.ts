import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataFactory } from 'n3';
import { afterEach, describe, expect, it } from 'vitest';

import { rebuildLocalRdfIndex } from '../../../src/storage/rdf/LocalRdfIndexRebuilder';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';

const { namedNode } = DataFactory;

describe('rebuildLocalRdfIndex', () => {
  const workDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(workDirs.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ rootDir: string; indexPath: string }> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'xpod-local-rdf-rebuild-'));
    workDirs.push(workDir);
    const rootDir = path.join(workDir, 'data');
    await mkdir(path.join(rootDir, 'alice', 'profile'), { recursive: true });
    await writeFile(path.join(rootDir, 'alice', 'profile', 'card$.ttl'), `
      @prefix solid: <http://www.w3.org/ns/solid/terms#> .
      <#me> solid:oidcIssuer <http://localhost:5737/> .
    `);
    await writeFile(path.join(rootDir, 'alice', 'README$.md'), '# ignored');
    return { rootDir, indexPath: path.join(workDir, 'rdf-index.sqlite') };
  }

  it('reports RDF files without creating the index during a dry run', async () => {
    const input = await fixture();
    const result = await rebuildLocalRdfIndex({
      ...input,
      baseUrl: 'http://localhost:5737/',
      dryRun: true,
    });

    expect(result).toMatchObject({ scanned: 2, indexed: 1, skipped: 1, failed: 0, dryRun: true });
  });

  it('restores extension-mapped resources, metadata, and containment', async () => {
    const input = await fixture();
    const result = await rebuildLocalRdfIndex({
      ...input,
      baseUrl: 'http://localhost:5737/',
    });
    expect(result).toMatchObject({ scanned: 2, indexed: 1, skipped: 1, failed: 0, dryRun: false });

    const engine = new SolidRdfEngine({ index: { path: input.indexPath } });
    try {
      engine.open();
      const card = 'http://localhost:5737/alice/profile/card';
      const cardFacts = await engine.scan({ pattern: { graph: namedNode(card) } });
      expect(cardFacts.quads).toHaveLength(1);
      expect(cardFacts.quads[0]?.object.value).toBe('http://localhost:5737/');

      const metadata = await engine.scan({ pattern: { graph: namedNode(`meta:${card}`) } });
      expect(metadata.quads.length).toBeGreaterThan(0);

      const parent = 'http://localhost:5737/alice/profile/';
      const rootMetadata = await engine.scan({
        pattern: { graph: namedNode('meta:http://localhost:5737/') },
      });
      expect(rootMetadata.quads.length).toBeGreaterThan(0);

      const parentMetadata = await engine.scan({
        pattern: { graph: namedNode(`meta:${parent}`) },
      });
      expect(parentMetadata.quads.length).toBeGreaterThan(0);

      const containment = await engine.scan({
        pattern: {
          graph: namedNode(parent),
          subject: namedNode(parent),
          predicate: namedNode('http://www.w3.org/ns/ldp#contains'),
          object: namedNode(card),
        },
      });
      expect(containment.quads).toHaveLength(1);

      const readme = 'http://localhost:5737/alice/README';
      const readmeMetadata = await engine.scan({
        pattern: { graph: namedNode(`meta:${readme}`) },
      });
      expect(readmeMetadata.quads.some((entry) => (
        entry.predicate.value === 'http://www.w3.org/ns/ma-ont#format'
          && entry.object.value === 'text/markdown'
      ))).toBe(true);

      const rootContainment = await engine.scan({
        pattern: {
          graph: namedNode('http://localhost:5737/alice/'),
          subject: namedNode('http://localhost:5737/alice/'),
          predicate: namedNode('http://www.w3.org/ns/ldp#contains'),
          object: namedNode(readme),
        },
      });
      expect(rootContainment.quads).toHaveLength(1);
    } finally {
      await engine.close();
    }
  });

  it('records malformed RDF and continues rebuilding later resources', async () => {
    const input = await fixture();
    await writeFile(path.join(input.rootDir, 'alice', 'zzz-bad$.ttl'), '<broken');
    await writeFile(path.join(input.rootDir, 'alice', 'zzzz-valid$.ttl'), `
      @prefix schema: <https://schema.org/> .
      <#item> schema:name "still indexed" .
    `);

    const result = await rebuildLocalRdfIndex({
      ...input,
      baseUrl: 'http://localhost:5737/',
    });

    expect(result).toMatchObject({ scanned: 4, indexed: 2, skipped: 1, failed: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain('zzz-bad$.ttl');

    const engine = new SolidRdfEngine({ index: { path: input.indexPath } });
    try {
      engine.open();
      const graph = namedNode('http://localhost:5737/alice/zzzz-valid');
      const restored = await engine.scan({ pattern: { graph } });
      expect(restored.quads.map((quad) => quad.object.value)).toContain('still indexed');
    } finally {
      await engine.close();
    }
  });
});

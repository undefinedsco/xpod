import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Generator } from 'componentsjs-generator';
import { ResolutionContext } from 'componentsjs-generator/lib/resolution/ResolutionContext';

test('the built AFS artifact exposes its journal constructor options to a real external Components generator', async () => {
  const repo = path.resolve(import.meta.dir, '../../..');
  const parent = path.join(repo, '.test-data/afs-component-contract');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'consumer-'));
  try {
    // Copy the declared artifact, never redirect workspace resolution or copy
    // the interface into the consumer's own source/metadata.
    const artifact = path.join(root, 'node_modules/@undefineds.co/xpod-afs');
    mkdirSync(artifact, { recursive: true });
    const afs = path.join(repo, 'packages/xpod-afs');
    cpSync(path.join(afs, 'package.json'), path.join(artifact, 'package.json'));
    cpSync(path.join(afs, 'dist'), path.join(artifact, 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: '@undefineds.co/afs-component-consumer', version: '0.0.0', types: 'dist/index.d.ts',
      dependencies: { '@undefineds.co/xpod-afs': '0.1.0-preview.1' },
      'lsd:module': 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/afs-component-consumer',
      'lsd:components': 'dist/components/components.jsonld',
      'lsd:contexts': { 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/afs-component-consumer/^0.0.0/components/context.jsonld': 'dist/components/context.jsonld' },
      'lsd:importPaths': { 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/afs-component-consumer/^0.0.0/dist/': 'dist/' },
    }));
    writeFileSync(path.join(root, 'dist/index.d.ts'), `
import type { SolidFsSyncJournalOptions } from '@undefineds.co/xpod-afs/workcopy/SolidFsSyncJournal';
export declare class JournalConsumer { constructor(options: SolidFsSyncJournalOptions); }
`);
    const journalPath = path.join(artifact, 'dist/types/workcopy/SolidFsSyncJournal.jsonld');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const definitions = new Map<string, { '@id': string; parameters?: Array<{ range?: string }> }>(
      journal.components.map((component: { '@id': string }) => [component['@id'], component]));
    const sqlite = [...definitions.values()].find(component => component['@id'].endsWith('#SqliteSolidFsSyncJournal'))!;
    const options = sqlite.parameters![0].range!;
    expect(options.endsWith('#SolidFsSyncJournalOptions')).toBe(true);
    expect(definitions.has(options)).toBe(true);
    const index = JSON.parse(readFileSync(path.join(artifact, 'dist/components/components.jsonld'), 'utf8'));
    expect(index.import.includes('undefinedsAfs:dist/types/workcopy/SolidFsSyncJournal.jsonld')).toBe(true);
    const values = JSON.parse(readFileSync(path.join(artifact, 'dist/public-value-exports.json'), 'utf8'));
    expect(values['.'].includes('SolidFsSyncJournalOptions')).toBe(false);
    const ignore = JSON.parse(readFileSync(path.join(repo, 'config/components-ignore.json'), 'utf8')) as string[];
    const generate = () => new Generator({ resolutionContext: new ResolutionContext(), pathDestinations: [{
      packageRootDirectory: root, originalPath: path.join(root, 'src'), replacementPath: path.join(root, 'dist/components'),
    }], fileExtension: 'jsonld', ignoreClasses: Object.fromEntries(ignore.map(name => [name, true])),
    logLevel: 'error', debugState: false, prefixes: { '@undefineds.co/afs-component-consumer': 'consumer' },
    hardErrorUnsupported: true }).generateComponents();
    await generate();
    expect(existsSync(path.join(root, 'dist/index.jsonld'))).toBe(true);
    const metadata = readFileSync(path.join(root, 'dist/index.jsonld'), 'utf8');
    expect(metadata.includes('SolidFsSyncJournalOptions')).toBe(true);
    // The explicit copied artifact is the authority: removing only its exposed
    // option definition must fail instead of borrowing the workspace package.
    journal.components = journal.components.filter((component: { '@id': string }) => component['@id'] !== options);
    writeFileSync(journalPath, JSON.stringify(journal));
    await expect(generate()).rejects.toThrow("does not expose this component");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

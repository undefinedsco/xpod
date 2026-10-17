import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stagePreviewClients } from '../scripts/stage-preview-clients';

declare const Bun: {
  build(options: { entrypoints: string[]; target: 'node'; format: 'esm'; metafile: true }): Promise<{
    success: boolean;
    metafile: { inputs: Record<string, unknown> };
  }>;
};

test('preview compiles public SDK exports from its one staged canonical source, not workspace dist', async () => {
  const parent = path.resolve(import.meta.dir, '../../../.test-data/preview-client-staging');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  const put = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  try {
    put('repo/packages/xpod-client/package.json', JSON.stringify({ name: '@undefineds.co/xpod-client', exports: { '.': {}, './session': {} } }));
    put('repo/packages/xpod-client/src/index.ts', 'export const value=41;');
    put('repo/packages/xpod-client/src/session.ts', 'export const session=1;');
    put('repo/packages/xpod-afs/src/index.ts', 'export {};');
    put('stage/packages/xpod-cli/src/client.ts', "export * from '@undefineds.co/xpod-client';");
    put('stage/packages/xpod-cli/src/lib/output.ts', 'export const output=0;');
    put('stage/src/main.ts', `import {value} from '@undefineds.co/xpod-client';
import {session} from "@undefineds.co/xpod-client/session";
import {output} from '@undefineds.co/xpod-cli/output';
export const packageName='@undefineds.co/xpod-client';export const answer=value+session+output;`);
    stagePreviewClients(path.join(root, 'repo'), path.join(root, 'stage'));
    const source = readFileSync(path.join(root, 'stage/src/main.ts'), 'utf8');
    expect(source).toContain("packageName='@undefineds.co/xpod-client'");
    const built = await Bun.build({ entrypoints: [path.join(root, 'stage/src/main.ts')], target: 'node', format: 'esm', metafile: true });
    expect(built.success).toBe(true);
    const inputs = Object.keys(built.metafile.inputs)
      .map(file => path.resolve(file));
    expect(inputs.every(file => file.startsWith(path.join(root, 'stage') + path.sep))).toBe(true);
    expect(inputs.filter(file => file.includes('runtime-client')).length).toBe(2);
    expect(inputs).toContain(path.join(root, 'stage/packages/xpod-cli/src/lib/output.ts'));
    expect(readFileSync(path.join(root, 'stage/packages/xpod-cli/src/runtime-client/index.ts'), 'utf8')).toBe('export const value=41;');
    put('stage/src/unknown.ts', "import '@undefineds.co/xpod-client/unknown';");
    expect(() => stagePreviewClients(path.join(root, 'repo'), path.join(root, 'stage'))).toThrow('Unknown preview runtime client import');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

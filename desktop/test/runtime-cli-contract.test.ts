import { expect, test } from 'bun:test';
import yargs from 'yargs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { desktopRuntimeArguments } from '../src/runtime-manager';
import { startCommand } from '../../packages/xpod-cli/src/commands/start';
import { ModuleStore } from '../../packages/xpod-cli/src/module-store';

test('desktop arguments pass the public strict CLI parser and real start handler up to module admission', async () => {
  const base = path.resolve(import.meta.dir, '../../.test-data/desktop-cli-contract');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  let parsed: Record<string, unknown> | undefined;
  let admitted: string[] | undefined;
  const sentinel = new Error('stop before capability installation');
  const store = new ModuleStore({ root: path.join(root, 'modules') });
  store.withAdmittedModules = async ids => { admitted = ids; throw sentinel; };
  const command = startCommand(store);
  const handler = command.handler as (argv: any) => Promise<void>;
  const parse = async (args: string[]) => yargs(args).exitProcess(false).command({ ...command,
    handler: async argv => { parsed = argv; await handler(argv); },
  }).strict().fail((message, error) => { throw error ?? new Error(message); }).parseAsync();
  try {
    const data = path.join(root, '用户 data');
    const args = desktopRuntimeArguments(['start'], 'http://127.0.0.1:41987', {
      XPOD_EDITION: 'cloud', CSS_ROOT_FILE_PATH: data,
    });
    await expect(parse(args)).rejects.toThrow(sentinel.message);
    expect(parsed).toMatchObject({ port: 41987, baseUrl: 'http://127.0.0.1:41987/', mode: 'cloud', data });
    expect(admitted).toEqual(['css', 'api']);
    admitted = undefined;
    await expect(parse(['start', '--foreground'])).rejects.toThrow('foreground');
    expect(admitted).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

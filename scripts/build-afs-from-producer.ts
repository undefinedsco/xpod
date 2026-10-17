import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { buildObserver } from '../packages/xpod-afs/scripts/build-observation';
import path from 'node:path';
import { x } from 'tar';
import { resolveProducerInput } from '../packages/xpod-afs/scripts/producer-input';
import { resolveProducerMaterials } from '../packages/xpod-afs/scripts/producer-materials';

const args = process.argv.slice(2);
const modes = args.flatMap((value, index) => value === '--mode' ? [index] : []);
if (modes.length !== 1) throw new Error('Required exactly one --mode');
const modeIndex = modes[0];
const mode = args[modeIndex + 1];
if (mode !== 'client' && mode !== 'module') throw new Error('Invalid AFS build mode');
if (args.includes('--client-package')) throw new Error('SDK input comes from the producer publication');
const forwarded = args.filter((_, index) => index !== modeIndex && index !== modeIndex + 1);
const input = resolveProducerInput(forwarded);
const repo = path.resolve(import.meta.dir, '..');
const temporaryRoot = path.join(repo, '.test-data');
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(path.join(temporaryRoot, 'afs-producer-build-'));
let primary: unknown;
let failed = false;
try {
  const packed = await buildObserver.command('driver-cli-pack', process.execPath, ['pm', 'pack', '--destination', temporary], input.root);
  if (packed.error || packed.status !== 0) throw packed.error ?? new Error('CLI producer normal package failed');
  const archives = readdirSync(temporary).filter(name => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('CLI producer archive is ambiguous');
  const cli = path.join(temporary, 'cli');
  mkdirSync(cli);
  await buildObserver.phase('driver-cli-extract', () => x({ file: path.join(temporary, archives[0]), cwd: cli, sync: true, strict: true }));
  const producer = resolveProducerInput(['--cli-package', path.join(cli, 'package')]);
  await buildObserver.phase('driver-materials', () => resolveProducerMaterials(producer.indexPath, undefined, producer.tools));
  const index = JSON.parse(readFileSync(producer.indexPath, 'utf8'));
  const clients = index.runtimeClients?.filter((client: { name: string }) => client.name === '@undefineds.co/xpod-client');
  if (!Array.isArray(clients) || clients.length !== 1) throw new Error('Required one published runtime client');
  const materialRoot = path.dirname(producer.indexPath);
  const material = (relative: string): string => {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || /[\x00-\x1f\x7f\\]/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe publication path');
    return path.join(materialRoot, relative);
  };
  const publication = clients[0].publication;
  if (!publication || typeof publication !== 'object') throw new Error('Missing runtime client publication');
  await buildObserver.phase('driver-sdk-verify', () => producer.tools.verifyProducerSourceArchive({ archive: material(publication.archive), inventory: material(publication.inventory) }));
  const sdk = path.join(temporary, 'sdk');
  mkdirSync(sdk);
  await buildObserver.phase('driver-sdk-extract', () => x({ file: material(publication.archive), cwd: sdk, sync: true, strict: true }));
  const clientRoot = path.join(sdk, 'package');
  await buildObserver.phase('driver-runtime-materials', () => resolveProducerMaterials(producer.indexPath, clientRoot, producer.tools));
  const childArgs = forwarded.filter((_, index) => forwarded[index - 1] !== '--cli-package' && forwarded[index] !== '--cli-package');
  const build = await buildObserver.command('driver-' + mode, process.execPath, [path.join(repo, 'packages/xpod-afs/scripts', mode === 'client' ? 'build-client.ts' : 'build-package.ts'),
    ...childArgs, '--cli-package', producer.root, '--client-package', clientRoot], repo);
  if (build.error || build.status !== 0) throw build.error ?? new Error('AFS artifact build failed');
} catch (error) {
  primary = error;
  failed = true;
  throw error;
} finally {
  await buildObserver.cleanup('driver-cleanup', () => rmSync(temporary, { recursive: true }), failed ? { error: primary } : undefined);
}

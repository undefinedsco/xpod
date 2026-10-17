import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductOriginalView } from './product-original';
import type { CollectedNativeOriginalsView } from './native-originals';

/** Invoked only while the central native capability lends its verified ZIP.
 * The fixed scanner reads tar payloads as streams and never extracts them. */
async function observeOwnedNativeOriginals(view: CollectedNativeOriginalsView, kind: 'tar' | 'afs-linux', arguments_: readonly string[]) {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const script = path.join(repository, 'scripts/lib/independent-admission/', kind === 'tar' ? 'native-original-tar.py' : 'native-afs-runtime.py');
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const policyFiles = [script, ...(kind === 'afs-linux' ? ['scripts/agentfs-native-ci/accept.py', 'scripts/agentfs-native-ci/supervise.py'].map(file => path.join(repository, file)) : [])];
  const policy = policyFiles.map(file => hash(readFileSync(file)));
  const parent = path.join(repository, '.test-data/native-tar-observations'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'owned-'));
  const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
  let removable = false;
  try {
    return await view.withArchiveFile(async original => {
      let result;
      try {
        result = await runPublicationCommand(realpathSync('/usr/bin/python3'), ['-I', '-B', script, original.path, ...arguments_], {
          cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' }, evidence: directory,
          label: 'native-tar', timeoutMs: 120000, rawLimit: 8 * 1024 ** 2,
        });
      } catch (error) {
        const outcome = (error as { outcome?: { groupAbsent?: boolean; actualClose?: boolean; actualWait?: boolean } }).outcome;
        removable = Boolean(outcome?.groupAbsent && outcome.actualClose && outcome.actualWait); throw error;
      }
      removable = result.groupAbsent && result.actualClose && result.actualWait;
      if (!removable || result.code !== 0 || !result.rawComplete || !result.rawClosedBeforeHash || !result.pipeEOF?.every(Boolean)
        || policyFiles.some((file, index) => hash(readFileSync(file)) !== policy[index])) throw Error('Native tar observer actual close/policy verification failed');
      for (const raw of result.raw) {
        const bytes = readFileSync(path.join(directory, raw.path));
        if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) throw Error('Native tar observer closed raw changed');
      }
      const observed = JSON.parse(readFileSync(path.join(directory, result.raw[0].path), 'utf8'));
      return observed;
    });
  } finally { if (removable) rmSync(directory, { recursive: true, force: true }); }
}

export async function observeRegisteredNativeTar(view: CollectedNativeOriginalsView, member: string, profile: 'runtime' | 'source' | 'afs-package') {
  const row = view.members.find(row => row.path === member);
  if (!row || row.bytes > 512 * 1024 ** 2) throw Error('Registered bounded native tar member required');
  const rows = await observeOwnedNativeOriginals(view, 'tar', [member, profile]);
  if (!Array.isArray(rows) || rows.length > 25000) throw Error('Native tar observer output inventory invalid');
  return Object.freeze(rows.map(row => Object.freeze(row)));
}

export async function observeRegisteredAfsLinuxRuntime(view: CollectedNativeOriginalsView, target: string, binary: ProductOriginalView) {
  if (!['linux-arm64', 'linux-x64'].includes(target) || binary.reference.sizeBytes < 64) throw Error('Bound AgentFS Linux original required');
  const observed = await observeOwnedNativeOriginals(view, 'afs-linux', [target, binary.readRange(0, 64).toString('hex'), binary.reference.sha256]);
  if (observed?.schemaVersion !== 1 || observed.status !== 'mechanical-agentfs-linux-runtime-verified' || observed.target !== target
    || observed.binarySha256 !== binary.reference.sha256) throw Error('Canonical AgentFS Linux ABI observation differs from product binding');
  return Object.freeze(observed);
}

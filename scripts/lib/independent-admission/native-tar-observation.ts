import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectedNativeOriginalsView } from './native-originals';

/** Invoked only while the central native capability lends its verified ZIP.
 * The fixed scanner reads tar payloads as streams and never extracts them. */
export async function observeRegisteredNativeTar(view: CollectedNativeOriginalsView, member: string, profile: 'runtime' | 'source') {
  const row = view.members.find(row => row.path === member);
  if (!row || row.bytes > 512 * 1024 ** 2) throw Error('Registered bounded native tar member required');
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const script = path.join(repository, 'scripts/lib/independent-admission/native-original-tar.py');
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const policy = hash(readFileSync(script));
  const parent = path.join(repository, '.test-data/native-tar-observations'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'owned-'));
  const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
  let removable = false;
  try {
    return await view.withArchiveFile(async original => {
      let result;
      try {
        result = await runPublicationCommand(realpathSync('/usr/bin/python3'), ['-I', '-B', script, original.path, member, profile], {
          cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' }, evidence: directory,
          label: 'native-tar', timeoutMs: 120000, rawLimit: 8 * 1024 ** 2,
        });
      } catch (error) {
        const outcome = (error as { outcome?: { groupAbsent?: boolean; actualClose?: boolean; actualWait?: boolean } }).outcome;
        removable = Boolean(outcome?.groupAbsent && outcome.actualClose && outcome.actualWait); throw error;
      }
      removable = result.groupAbsent && result.actualClose && result.actualWait;
      if (!removable || result.code !== 0 || !result.rawComplete || !result.rawClosedBeforeHash || !result.pipeEOF?.every(Boolean)
        || hash(readFileSync(script)) !== policy) throw Error('Native tar observer actual close/policy verification failed');
      for (const raw of result.raw) {
        const bytes = readFileSync(path.join(directory, raw.path));
        if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) throw Error('Native tar observer closed raw changed');
      }
      const rows = JSON.parse(readFileSync(path.join(directory, result.raw[0].path), 'utf8'));
      if (!Array.isArray(rows) || rows.length > 25000) throw Error('Native tar observer output inventory invalid');
      return Object.freeze(rows.map(row => Object.freeze(row)));
    });
  } finally { if (removable) rmSync(directory, { recursive: true, force: true }); }
}

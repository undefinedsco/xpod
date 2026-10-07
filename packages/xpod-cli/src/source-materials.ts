import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256File, sha256Hex } from './manifest';

export interface SourceFile { path: string; sha256: string; sizeBytes: number }

export function safeMaterialPath(file: string): boolean {
  return typeof file === 'string' && file.length > 0 && !path.isAbsolute(file) && !file.includes('\\') && !/[\x00-\x1f\x7f]/.test(file) &&
    file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function sourceFileIndex(files: SourceFile[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    if (!safeMaterialPath(file.path) || index.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new Error('Unsafe source kit file');
    }
    index.set(file.path, file.sha256);
  }
  return index;
}

export function verifySourceFiles(root: string, files: SourceFile[]): void {
  sourceFileIndex(files);
  const boundary = realpathSync(root);
  for (const file of files) {
    const candidate = path.join(root, file.path);
    const original = realpathSync(candidate);
    const relative = path.relative(boundary, original);
    if (lstatSync(candidate).isSymbolicLink() || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) ||
      sha256File(original) !== file.sha256 || statSync(original).size !== file.sizeBytes) {
      throw new Error(`Source kit drift: ${file.path}`);
    }
  }
}

/** Preflight every archive member before extraction, then verify every declared byte. */
export function verifySourceArchive(archive: string, expectedIndex: Buffer, rootName: string, files: SourceFile[], validate?: (root: string) => void): void {
  if (!safeMaterialPath(rootName) || rootName.includes('/')) { throw new Error('Unsafe source archive root'); }
  sourceFileIndex(files);
  const expectedFiles = new Set([`${rootName}/source-kit.json`, ...files.map((file) => `${rootName}/${file.path}`)]);
  const directories = new Set<string>();
  for (const file of expectedFiles) {
    for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) { directories.add(directory); }
  }
  const list = (verbose: boolean): string[] => {
    const result = spawnSync('tar', [verbose ? '-tvf' : '-tf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) { throw new Error('Cannot inspect source archive'); }
    return result.stdout.trimEnd().split('\n');
  };
  const names = list(false);
  const types = list(true);
  if (names.length !== types.length) { throw new Error('Ambiguous source archive listing'); }
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i].replace(/\/$/, '');
    const type = types[i][0];
    if (!safeMaterialPath(name) || seen.has(name) ||
      (type === '-' ? !expectedFiles.has(name) : type === 'd' ? !directories.has(name) : true)) {
      throw new Error(`Unsafe, duplicate or unlisted source archive member: ${name}`);
    }
    seen.add(name);
  }
  for (const file of expectedFiles) { if (!seen.has(file)) { throw new Error(`Archive material missing: ${file}`); } }
  const temporary = mkdtempSync(path.join(tmpdir(), 'xpod-cli-source-verify-'));
  try {
    const result = spawnSync('tar', ['--no-same-owner', '-xf', archive, '-C', temporary], { encoding: 'utf8' });
    if (result.status !== 0) { throw new Error('Cannot extract source archive'); }
    const root = path.join(temporary, rootName);
    if (sha256File(path.join(root, 'source-kit.json')) !== sha256Hex(expectedIndex)) { throw new Error('Source archive index mismatch'); }
    verifySourceFiles(root, files);
    validate?.(root);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

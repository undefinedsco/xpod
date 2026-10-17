import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface RuntimePin { version: string; target: string; sourceCommit: string; archiveSha256: string; executableSha256: string; entry: string; }

/** Only regular members with the exact pinned layout are admitted; nothing is executed. */
export function runtimeArchiveExecutable(archive: Buffer, pin: RuntimePin): Buffer {
  if (sha(archive) !== pin.archiveSha256) throw new Error('Bun archive digest mismatch');
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < archive.length - 65557 || end + 22 + archive.readUInt16LE(end + 20) !== archive.length) throw new Error('Invalid ZIP directory');
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6)) throw new Error('Multi-disk ZIP rejected');
  const count = archive.readUInt16LE(end + 10);
  if (count !== archive.readUInt16LE(end + 8) || count < 1 || count > 2) throw new Error('Unexpected Bun archive members');
  const directory = archive.readUInt32LE(end + 16);
  let offset = directory;
  let executable: Buffer | undefined;
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP member');
    const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10);
    const packed = archive.readUInt32LE(offset + 20), size = archive.readUInt32LE(offset + 24);
    const length = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32);
    if (offset + 46 + length + extra + comment > end) throw new Error('Truncated ZIP member');
    const name = archive.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const mode = archive.readUInt32LE(offset + 38) >>> 16;
    const isDirectory = name === pin.entry.slice(0, pin.entry.lastIndexOf('/') + 1);
    if (names.has(name) || (!isDirectory && name !== pin.entry) || (flags & 1) || ![0, 8].includes(method)) throw new Error('Unsafe ZIP member');
    names.add(name);
    if (isDirectory ? (mode & 0xf000) !== 0x4000 : (mode & 0xf000) !== 0x8000 || (mode & 0o111) === 0 || (mode & 0o7000) !== 0) throw new Error('Invalid Bun archive mode');
    const local = archive.readUInt32LE(offset + 42);
    if (local + 30 > directory || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const localNameLength = archive.readUInt16LE(local + 26), localExtra = archive.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtra;
    if (start + packed > directory || archive.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name
      || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method || size > 64 * 1024 * 1024) throw new Error('Invalid ZIP payload bounds');
    if (!isDirectory) {
      const content = archive.subarray(start, start + packed);
      executable = method === 8 ? inflateRawSync(content, { maxOutputLength: 64 * 1024 * 1024 }) : Buffer.from(content);
      if (executable.length !== size || sha(executable) !== pin.executableSha256) throw new Error('Bun executable digest mismatch');
    } else if (size !== 0) throw new Error('Nonempty ZIP directory');
    offset += 46 + length + extra + comment;
  }
  if (offset !== end || offset - directory !== archive.readUInt32LE(end + 12) || !executable) throw new Error('Incomplete Bun archive');
  return executable;
}

function regular(file: string): Buffer {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Runtime input must be a regular file');
  return readFileSync(file);
}

/** Explicit producer input, never a user runtime setting or current-machine Bun copy. */
export function stageBundledBun(repoRoot: string, destination: string, descriptorFile: string): void {
  const descriptor = JSON.parse(regular(descriptorFile).toString());
  if (!['release', 'controlled-preview'].includes(descriptor.mode)) throw new Error('Explicit runtime distribution mode required');
  const resolve = (file: string) => path.resolve(path.dirname(descriptorFile), file);
  const provenance = JSON.parse(regular(path.join(repoRoot, 'packages/xpod-cli/licenses/javascript/generated/1.4.2/index.json')).toString()).provenance;
  const compiler = provenance.compiler;
  if (descriptor.target !== compiler.platform || descriptor.target !== 'darwin-arm64') throw new Error('Unsupported Bun runtime target');
  const authorityBytes = regular(resolve(descriptor.authority));
  if (sha(authorityBytes) !== descriptor.authoritySha256) throw new Error('Runtime authority digest mismatch');
  const authority = JSON.parse(authorityBytes.toString());
  if (authority.schemaVersion !== 1 || authority.version !== '1.4.2' || authority.target !== descriptor.target
    || authority.executableSha256 !== compiler.executableSha256 || authority.sourceCommit !== provenance.bunCommit) throw new Error('Runtime authority identity mismatch');
  const assessment = authority.assessment;
  if (!assessment || !['pending', 'verified'].includes(assessment.status) || !Array.isArray(assessment.applicableRequirements)
    || !Array.isArray(authority.files)) throw new Error('Missing runtime materials assessment');
  const materials = authority.files.map((file: { path: string; sha256: string; sourceUrl: string; kind: string }) => {
    if (!['license', 'source', 'relink', 'assessment'].includes(file.kind) || !/^https:\/\//.test(file.sourceUrl)) throw new Error('Invalid runtime material provenance');
    const bytes = regular(resolve(file.path));
    if (sha(bytes) !== file.sha256) throw new Error('Runtime material digest mismatch');
    return { ...file, bytes };
  });
  if (descriptor.mode === 'release' && (assessment.status !== 'verified' || typeof assessment.reviewer !== 'string' || !assessment.reviewer.trim()
    || !materials.some((file: { kind: string }) => file.kind === 'license')
    || !['source', 'relink', 'assessment'].every(kind => materials.some((file: { kind: string }) => file.kind === kind))
    || assessment.applicableRequirements.some((kind: string) => !['license', 'source', 'relink'].includes(kind)
      || !materials.some((file: { kind: string }) => file.kind === kind)))) throw new Error('Release runtime materials are incomplete');
  const license = JSON.parse(regular(path.join(repoRoot, 'packages/xpod-cli/licenses/javascript/generated/1.4.2/index.json')).toString()).files.find((file: { sourcePath: string }) => file.sourcePath === 'LICENSE.md');
  if (descriptor.mode === 'release' && (!license || !materials.some((file: { kind: string; sha256: string }) => file.kind === 'license' && file.sha256 === license.sha256))) throw new Error('Original Bun root license missing');
  const archive = regular(resolve(descriptor.archive));
  const executable = runtimeArchiveExecutable(archive, { version: '1.4.2', target: descriptor.target, sourceCommit: provenance.bunCommit,
    archiveSha256: compiler.officialArchiveSha256, executableSha256: compiler.executableSha256, entry: 'bun-darwin-aarch64/bun' });
  mkdirSync(path.join(destination, 'bin'), { recursive: true });
  writeFileSync(path.join(destination, 'bin/bun'), executable, { mode: 0o755, flag: 'wx' });
  chmodSync(path.join(destination, 'bin/bun'), 0o755);
  const materialRoot = path.join(destination, 'licenses/bun');
  mkdirSync(materialRoot, { recursive: true });
  const files = materials.map((file: { kind: string; sourceUrl: string; sha256: string; bytes: Buffer }, index: number) => {
    const relative = `${index}-${file.kind}.original`;
    writeFileSync(path.join(materialRoot, relative), file.bytes, { flag: 'wx', mode: 0o644 });
    return { path: relative, kind: file.kind, sourceUrl: file.sourceUrl, sha256: file.sha256 };
  });
  writeFileSync(path.join(materialRoot, 'authority.original.json'), authorityBytes, { flag: 'wx' });
  writeFileSync(path.join(materialRoot, 'receipt.json'), JSON.stringify({ version: '1.4.2', target: descriptor.target,
    runtimePhase: 'pre-sign', revision: provenance.revision,
    archiveUrl: compiler.officialArchiveUrl, archiveSha256: sha(archive), executableSha256: sha(executable), sourceCommit: provenance.bunCommit,
    mode: descriptor.mode, authoritySha256: descriptor.authoritySha256, assessment,
    releaseQualified: descriptor.mode === 'release', legalComplete: descriptor.mode === 'release',
    qualificationBasis: 'Explicit supplied binary-runtime authority and material hashes; never the JS prefix assessment', files,
  }, null, 2));
}

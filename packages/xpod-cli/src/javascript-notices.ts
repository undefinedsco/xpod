import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256File } from './manifest';

interface BuildMetafile {
  inputs: Record<string, { bytes: number; imports: { path: string; external?: boolean }[] }>;
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
}

interface PackageNotice {
  name: string;
  version: string;
  root: string;
  packageJsonSha256: string;
  declaredLicense: unknown;
  inputCount: number;
  noticeStatus: 'collected-candidates' | 'missing-original';
  files: NoticeFile[];
}

interface NoticeFile {
  sourcePath: string;
  object: string;
  sha256: string;
  provenance?: unknown;
}

interface NoticeSupplement {
  name: string;
  version: string;
  provenance: unknown;
  files: NoticeFile[];
}

interface GeneratedNoticeIndex {
  schemaVersion: number;
  bunVersion: string;
  prefixSha256: string;
  prefixBytes: number;
  provenance: unknown;
  files: NoticeFile[];
}

function supplements(directory?: string): Map<string, NoticeSupplement> {
  const entries = new Map<string, NoticeSupplement>();
  if (!directory) { return entries; }
  const index = JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')) as { schemaVersion: number; entries: NoticeSupplement[] };
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries)) { throw new Error('Invalid JavaScript notice supplements'); }
  for (const entry of index.entries) {
    const key = JSON.stringify([entry.name, entry.version]);
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.version !== 'string' || !entry.version || !Array.isArray(entry.files) || entries.has(key)) {
      throw new Error('Invalid or duplicate JavaScript notice supplement');
    }
    for (const file of entry.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.object !== `objects/${file.sha256}.txt`) { throw new Error('Unsafe JavaScript supplement object'); }
    }
    entries.set(key, entry);
  }
  return entries;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function slash(file: string): string { return file.split(path.sep).join('/'); }

/** Nested package.json files used only for module type do not own a package. */
function packageOwner(file: string, dependencyRoot: string): { root: string; info: Record<string, unknown> } {
  let current = path.dirname(file);
  while (within(dependencyRoot, current)) {
    const manifest = path.join(current, 'package.json');
    if (existsSync(manifest)) {
      const info = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      if (typeof info.name === 'string' && typeof info.version === 'string') { return { root: current, info }; }
    }
    if (current === dependencyRoot) { break; }
    current = path.dirname(current);
  }
  throw new Error(`No named package owner for bundler input: ${file}`);
}

/** Root texts plus explicit license directories are candidates, not a complete per-file audit. */
function noticeCandidates(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, insideNotices: boolean): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isFile() && (insideNotices || /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(entry.name))) {
        files.push(filename);
      } else if (entry.isDirectory() && (insideNotices || /^(?:licen[cs]es|notices)$/i.test(entry.name))) {
        visit(filename, true);
      }
    }
  };
  visit(root, false);
  return files.sort();
}

/** Inventory the exact portable JS bundle inputs; externally installed runtimes are not shipped. */
export function collectJavascriptNotices(options: {
  metafile: string;
  stageRoot: string;
  repoRoot: string;
  destination: string;
  target: string;
  cli: string;
  bunVersion: string;
  supplements?: string;
  generated?: string;
  generatedProfile?: 'core' | 'client';
}): string[] {
  // Producer metadata for portable JavaScript, not native ABI admission.
  if (!/^[a-z][a-z0-9]*-[a-z][a-z0-9]*$/.test(options.target)) {
    throw new Error('Invalid JavaScript build target metadata');
  }
  const stageRoot = realpathSync(options.stageRoot);
  const dependencyRoot = realpathSync(path.join(options.repoRoot, 'node_modules'));
  const metadata = JSON.parse(readFileSync(options.metafile, 'utf8')) as BuildMetafile;
  if (!metadata.inputs || !metadata.outputs || Object.keys(metadata.inputs).length === 0 || Object.keys(metadata.outputs).length === 0) {
    throw new Error('Invalid JavaScript build metafile');
  }
  const packages = new Map<string, PackageNotice>();
  const supplementIndex = supplements(options.supplements);
  const objects = new Map<string, string>();
  let generated: GeneratedNoticeIndex | undefined;
  if (options.generated) {
    generated = JSON.parse(readFileSync(path.join(options.generated, 'index.json'), 'utf8')) as GeneratedNoticeIndex;
    if (options.generatedProfile) {
      const profile = JSON.parse(readFileSync(path.join(options.generated, `${options.generatedProfile}.json`), 'utf8'));
      if (profile.schemaVersion !== 1 || profile.bunVersion !== generated.bunVersion || profile.file?.sourcePath !== 'generated-prefix.js') {
        throw new Error('Unsupported generated JavaScript profile');
      }
      generated = { ...generated, prefixSha256: profile.prefixSha256, prefixBytes: profile.prefixBytes,
        provenance: { original: generated.provenance, profile: profile.provenance },
        files: [...generated.files.filter(file => file.sourcePath !== 'generated-prefix.js'), profile.file] };
    }
    if (generated.schemaVersion !== 1 || generated.bunVersion !== options.bunVersion ||
      !/^[a-f0-9]{64}$/.test(generated.prefixSha256) || !Number.isSafeInteger(generated.prefixBytes) || generated.prefixBytes < 1 ||
      !Array.isArray(generated.files) || !generated.files.length) {
      throw new Error('Unsupported generated JavaScript notice provenance');
    }
    const bytes = readFileSync(options.cli);
    const boundary = bytes.indexOf('\n// ');
    const prefix = bytes.subarray(0, boundary);
    if (boundary < 0 || prefix.length !== generated.prefixBytes || createHash('sha256').update(prefix).digest('hex') !== generated.prefixSha256) {
      throw new Error('Generated JavaScript prefix differs from audited sources');
    }
    for (const file of generated.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.object !== `objects/${file.sha256}.txt`) { throw new Error('Unsafe generated JavaScript notice object'); }
      const source = path.join(options.generated, file.object);
      if (sha256File(source) !== file.sha256) { throw new Error(`Generated JavaScript notice hash mismatch: ${file.object}`); }
      objects.set(file.object, source);
    }
  }
  const externalImports = new Set<string>();
  const inputs: { path: string; sha256: string; bytes: number; bytesInOutput: number; packageRoot?: string }[] = [];
  for (const [raw, input] of Object.entries(metadata.inputs)) {
    const candidate = path.resolve(stageRoot, raw);
    if (!within(dependencyRoot, candidate) && !within(stageRoot, candidate)) { throw new Error(`Unexpected bundler input outside staging/dependencies: ${raw}`); }
    const filename = realpathSync(candidate);
    const dependency = within(dependencyRoot, filename);
    if (!dependency && !within(stageRoot, filename)) { throw new Error(`Unexpected bundler input outside staging/dependencies: ${raw}`); }
    if (!Number.isFinite(input.bytes) || input.bytes < 0 || !Array.isArray(input.imports)) { throw new Error(`Invalid bundler input: ${raw}`); }
    let packageRoot: string | undefined;
    if (dependency) {
      const owner = packageOwner(filename, dependencyRoot);
      packageRoot = `node_modules/${slash(path.relative(dependencyRoot, owner.root))}`;
      let entry = packages.get(packageRoot);
      if (!entry) {
        const notices: NoticeFile[] = noticeCandidates(owner.root).map((file) => {
          const sha256 = sha256File(file);
          const object = `objects/${sha256}.txt`;
          objects.set(object, file);
          return { sourcePath: slash(path.relative(owner.root, file)), object, sha256 };
        });
        const supplemental = supplementIndex.get(JSON.stringify([owner.info.name, owner.info.version]));
        for (const file of supplemental?.files ?? []) {
          const source = path.join(options.supplements!, file.object);
          if (sha256File(source) !== file.sha256) { throw new Error(`JavaScript supplement hash mismatch: ${file.object}`); }
          objects.set(file.object, source);
          notices.push({ ...file, provenance: supplemental!.provenance });
        }
        entry = {
          name: owner.info.name as string, version: owner.info.version as string, root: packageRoot,
          packageJsonSha256: sha256File(path.join(owner.root, 'package.json')),
          declaredLicense: owner.info.license ?? owner.info.licenses ?? null,
          inputCount: 0, noticeStatus: notices.length > 0 ? 'collected-candidates' : 'missing-original', files: notices,
        };
        packages.set(packageRoot, entry);
      }
      entry.inputCount += 1;
    }
    let bytesInOutput = 0;
    for (const output of Object.values(metadata.outputs)) {
      const contribution = output.inputs?.[raw]?.bytesInOutput ?? 0;
      if (!Number.isFinite(contribution) || contribution < 0) { throw new Error(`Invalid output contribution: ${raw}`); }
      bytesInOutput += contribution;
    }
    inputs.push({
      path: dependency ? `node_modules/${slash(path.relative(dependencyRoot, filename))}` : slash(path.relative(stageRoot, filename)),
      sha256: sha256File(filename), bytes: input.bytes, bytesInOutput,
      ...(packageRoot ? { packageRoot } : {}),
    });
    for (const imported of input.imports) {
      if (!imported.external) { continue; }
      let name = imported.path;
      if (path.isAbsolute(name)) {
        if (within(dependencyRoot, name)) { name = `node_modules/${slash(path.relative(dependencyRoot, name))}`; }
        else if (within(stageRoot, name)) { name = slash(path.relative(stageRoot, name)); }
        else { throw new Error('Unexpected absolute external import outside staging/dependencies'); }
      }
      externalImports.add(name);
    }
  }
  const cliSha256 = sha256File(options.cli);
  // Inspect every input before writing. Preserve original bytes, including CRLF;
  // no package license declaration is converted into distribution clearance.
  mkdirSync(path.join(options.destination, 'objects'), { recursive: true });
  for (const [object, source] of objects) {
    const output = path.join(options.destination, object);
    cpSync(source, output);
    if (sha256File(output) !== path.basename(object, '.txt')) { throw new Error(`JavaScript notice changed during copy: ${object}`); }
  }
  writeFileSync(path.join(options.destination, 'index.json'), JSON.stringify({
    schemaVersion: 1, status: 'partial-collection', target: options.target, bunVersion: options.bunVersion,
    cliSha256,
    ...(generated ? { generated } : {}),
    scope: 'All inputs of this portable JS bundle invocation, including zero output contributions; no Bun/Node runtime is shipped. This is not a complete file-level license audit.',
    packages: [...packages.values()].sort((a, b) => a.root.localeCompare(b.root)),
    inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)),
    externalImports: [...externalImports].sort(),
  }, null, 2) + '\n');
  return ['index.json', ...objects.keys()];
}

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bunCompileTarget } from './native-target';
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
  files: { sourcePath: string; object: string; sha256: string }[];
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

/** Use the same --compile invocation's inputs; this does not inventory the embedded Bun runtime. */
export function collectJavascriptNotices(options: {
  metafile: string;
  stageRoot: string;
  repoRoot: string;
  destination: string;
  target: string;
  cli: string;
  bunVersion: string;
}): string[] {
  bunCompileTarget(options.target);
  const stageRoot = realpathSync(options.stageRoot);
  const dependencyRoot = realpathSync(path.join(options.repoRoot, 'node_modules'));
  const metadata = JSON.parse(readFileSync(options.metafile, 'utf8')) as BuildMetafile;
  if (!metadata.inputs || !metadata.outputs || Object.keys(metadata.inputs).length === 0 || Object.keys(metadata.outputs).length === 0) {
    throw new Error('Invalid JavaScript build metafile');
  }
  const packages = new Map<string, PackageNotice>();
  const objects = new Map<string, string>();
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
        const notices = noticeCandidates(owner.root).map((file) => {
          const sha256 = sha256File(file);
          const object = `objects/${sha256}.txt`;
          objects.set(object, file);
          return { sourcePath: slash(path.relative(owner.root, file)), object, sha256 };
        });
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
    scope: 'All inputs of this compile invocation, including zero output contributions; not the embedded Bun runtime or a complete file-level license audit.',
    packages: [...packages.values()].sort((a, b) => a.root.localeCompare(b.root)),
    inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)),
    externalImports: [...externalImports].sort(),
  }, null, 2) + '\n');
  return ['index.json', ...objects.keys()];
}

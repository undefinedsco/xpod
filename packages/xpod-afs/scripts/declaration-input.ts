import { createHash } from 'node:crypto';
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { resolveArtifactExport, resolveArtifactPath } from './producer-input';

// Match TypeScript's Node sys.readFile BOM semantics, decoding the very Buffer
// whose raw hash is bound. Never read a second file to attest compiler text.
function decodeCompilerSource(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return Buffer.from(bytes.subarray(2, bytes.length & ~1)).swap16().toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return bytes.toString('utf16le', 2);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return bytes.toString('utf8', 3);
  return bytes.toString('utf8');
}

/** Resolve the same explicit public SDKs for both value-export discovery and declarations. */
export function createDeclarationInput(roots: readonly string[], assertProducerCurrent: () => void) {
  const hashes = new Map<string, string>();
  const packages = new Map<string, Map<string, string>>();
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const remember = (file: string, bytes?: Buffer): void => {
    const owner = ownerOf(file);
    if (!owner) throw new Error('Declaration read outside owned SDK');
    resolveArtifactPath(owner, file);
    const actual = hash(bytes ?? fs.readFileSync(file)), previous = hashes.get(file);
    if (previous && previous !== actual) throw new Error('Declaration input changed: ' + file);
    hashes.set(file, actual);
  };
  const directories = roots.map(root => realpathSync(root));
  const ownerOf = (file: string): string | undefined => directories.find(root => file === root || file.startsWith(root + path.sep));
  const readOwned = (file: string): Buffer => {
    resolveArtifactPath(ownerOf(file)!, file);
    const bytes = fs.readFileSync(file); remember(file, bytes); return bytes;
  };
  assertProducerCurrent();
  for (const root of directories) {
    const file = path.join(root, 'package.json');
    const manifest = JSON.parse(decodeCompilerSource(readOwned(file)));
    if (typeof manifest.name !== 'string' || !manifest.name || packages.has(manifest.name)) throw new Error('Duplicate or missing declaration package identity');
    const bindings = new Map<string, string>();
    for (const [key, declaration] of Object.entries(manifest.exports ?? {}) as Array<[string, string | Record<string, string>]>) {
      if (key !== '.' && (!key.startsWith('./') || key.includes('*'))) throw new Error('Unsupported declaration export');
      // Data exports (package/producer JSON) have no runtime type surface.
      if (typeof declaration === 'string' && declaration.endsWith('.json')) continue;
      const selected = resolveArtifactExport(root, manifest.exports, key === '.' ? '' : key.slice(2), 'types');
      if (!/\.d\.[cm]?ts$/.test(selected)) throw new Error('Public SDK declaration target required');
      remember(selected); bindings.set(manifest.name + (key === '.' ? '' : key.slice(1)), selected);
    }
    if (!bindings.size) throw new Error('Public SDK has no declaration exports');
    packages.set(manifest.name, bindings);
  }
  const assertCurrent = (): void => {
    assertProducerCurrent();
    for (const [file, expected] of hashes) {
      resolveArtifactPath(ownerOf(file)!, file);
      if (hash(fs.readFileSync(file)) !== expected) throw new Error('Declaration input changed: ' + file);
    }
  };
  const createProgram = (parsed: ts.ParsedCommandLine): ts.Program => {
    assertCurrent();
    const host = ts.createCompilerHost(parsed.options);
    const originalRead = host.readFile.bind(host), originalExists = host.fileExists.bind(host), originalRealpath = host.realpath?.bind(host);
    host.fileExists = file => { const owner = ownerOf(file); if (owner) resolveArtifactPath(owner, file, true); return originalExists(file); };
    host.realpath = file => { const owner = ownerOf(file); return owner ? resolveArtifactPath(owner, file) : originalRealpath ? originalRealpath(file) : file; };
    const relativeOwner = (from: string, name: string): string | undefined => {
      const owner = ownerOf(from);
      if (!owner || !(name.startsWith('.') || path.isAbsolute(name))) return undefined;
      resolveArtifactPath(owner, path.resolve(path.dirname(from), name), true); return owner;
    };
    host.readFile = file => {
      const owner = ownerOf(file); if (owner) resolveArtifactPath(owner, file, true);
      const text = owner ? decodeCompilerSource(readOwned(file)) : originalRead(file);
      if (text !== undefined && owner) {
        const references = ts.preProcessFile(text, true);
        for (const reference of references.referencedFiles) resolveArtifactPath(owner, path.resolve(path.dirname(file), reference.fileName), true);
        for (const reference of references.typeReferenceDirectives) relativeOwner(file, reference.fileName);
      }
      return text;
    };
    const sdkType = (name: string): string | undefined => {
      for (const [identity, bindings] of packages) if (name === identity || name.startsWith(identity + '/')) {
        const selected = bindings.get(name);
        if (!selected) throw new Error('SDK type export not declared: ' + name);
        remember(selected); return selected;
      }
      return undefined;
    };
    host.resolveTypeReferenceDirectiveReferences = (references, containingFile, redirectedReference, options, containingSourceFile) => references.map(reference => {
      const name = typeof reference === 'string' ? reference : reference.fileName;
      const selected = sdkType(name);
      if (selected) return { resolvedTypeReferenceDirective: { resolvedFileName: selected, primary: true } };
      const owner = relativeOwner(containingFile, name);
      const resolved = ts.resolveTypeReferenceDirective(name, containingFile, options ?? parsed.options, host, redirectedReference, undefined,
        ts.getModeForFileReference(reference, containingSourceFile?.impliedNodeFormat));
      if (owner && resolved.resolvedTypeReferenceDirective?.resolvedFileName) resolveArtifactPath(owner, resolved.resolvedTypeReferenceDirective.resolvedFileName);
      return resolved;
    });
    host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options, containingSourceFile) => literals.map(literal => {
      const name = literal.text;
      const selected = sdkType(name);
      if (selected) return { resolvedModule: { resolvedFileName: selected, isExternalLibraryImport: true,
        extension: selected.endsWith('.d.mts') ? ts.Extension.Dmts : selected.endsWith('.d.cts') ? ts.Extension.Dcts : ts.Extension.Dts } };
      const owner = relativeOwner(containingFile, name);
      const resolved = ts.resolveModuleName(name, containingFile, options ?? parsed.options, host, undefined, redirectedReference,
        ts.getModeForUsageLocation(containingSourceFile, literal, options ?? parsed.options));
      if (owner && resolved.resolvedModule) resolveArtifactPath(owner, resolved.resolvedModule.resolvedFileName);
      return resolved;
    });
    return ts.createProgram(parsed.fileNames, parsed.options, host);
  };
  return { assertCurrent, createProgram };
}

export function emitDeclarations(config: string, input: ReturnType<typeof createDeclarationInput>): void {
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
  if (!parsed) throw new Error('AFS declaration configuration unavailable');
  const program = input.createProgram(parsed), diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (!diagnostics.length) diagnostics.push(...program.emit().diagnostics);
  if (diagnostics.length) throw new Error('AFS declarations build failed:\n' + ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
  }));
  input.assertCurrent();
}

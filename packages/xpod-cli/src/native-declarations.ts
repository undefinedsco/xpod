import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File, type SelectedEnginePin } from './manifest';
import type { NativeNoticeIndex } from './native-notices';

interface NoticeObject { object: string; sha256: string }

export interface NativeDeclarationIndex {
  schemaVersion: number;
  status: 'declarations-verified';
  scope: string;
  engine: Pick<SelectedEnginePin, 'engine' | 'repository' | 'commit'>;
  licenses: (NoticeObject & { spdx: string; sourceUrl: string; kind: 'standard-template' })[];
  packages: {
    name: string;
    version: string;
    declaredLicense: string;
    chosenLicense: string;
    declarationKind: 'cargo-manifest' | 'project-readme';
    source: { url: string; commit: string; archiveSha256?: string };
    declaration: NoticeObject;
  }[];
}

/** Verify declarations and terms, without treating them as full artifact clearance. */
export function validateNativeDeclarations(
  collection: string,
  pin: Pick<SelectedEnginePin, 'engine' | 'repository' | 'commit'>,
  inventory?: NativeNoticeIndex,
): string[] {
  const index = JSON.parse(readFileSync(path.join(collection, 'index.json'), 'utf8')) as NativeDeclarationIndex;
  if (index.schemaVersion !== 1 || index.status !== 'declarations-verified' || !index.scope ||
    !Array.isArray(index.packages) || !index.packages.length || !Array.isArray(index.licenses) ||
    index.engine?.engine !== pin.engine || index.engine?.repository !== pin.repository || index.engine?.commit !== pin.commit) {
    throw new Error('Invalid native declaration index or engine pin');
  }
  const objects = new Set<string>();
  const readObject = (file: NoticeObject): string => {
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || file.object !== `objects/${file.sha256}.txt`) {
      throw new Error('Unsafe declaration object');
    }
    const source = path.join(collection, file.object);
    if (sha256File(source) !== file.sha256) { throw new Error(`Declaration hash mismatch: ${file.object}`); }
    objects.add(file.object);
    return readFileSync(source, 'utf8');
  };
  const terms = new Set<string>();
  for (const license of index.licenses) {
    if (!license.spdx || terms.has(license.spdx) || license.kind !== 'standard-template' || !license.sourceUrl?.startsWith('https://')) {
      throw new Error('Invalid standard license term provenance');
    }
    terms.add(license.spdx);
    readObject(license);
  }
  const packages = new Map<string, string>();
  for (const entry of index.packages) {
    if (!entry.name || !entry.version || packages.has(entry.name) || !/^[a-f0-9]{40}$/.test(entry.source?.commit) ||
      !entry.source?.url?.startsWith('https://') ||
      (entry.source.archiveSha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.source.archiveSha256))) {
      throw new Error('Invalid or duplicate declaration package provenance');
    }
    packages.set(entry.name, entry.version);
    const expectedKind = entry.name === pin.engine ? 'project-readme' : 'cargo-manifest';
    if (entry.declarationKind !== expectedKind) { throw new Error(`Declaration kind mismatch: ${entry.name}`); }
    // These supplements select one permissive alternative, not an AND expression.
    const alternatives = entry.declaredLicense.split(/\s+OR\s+|\//);
    if (!alternatives.includes(entry.chosenLicense) || !terms.has(entry.chosenLicense)) {
      throw new Error(`Unproven license alternative: ${entry.name}`);
    }
    const original = readObject(entry.declaration);
    let declared: string | undefined;
    if (entry.declarationKind === 'cargo-manifest') {
      const section = /^\[package\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(original)?.[1] ?? '';
      const field = (name: string): string | undefined => new RegExp(`^${name}\\s*=\\s*["']([^"']+)["'][ \\t]*(?:#.*)?$`, 'm').exec(section)?.[1];
      if (field('name') !== entry.name || field('version') !== entry.version) {
        throw new Error(`Declaration package identity mismatch: ${entry.name}`);
      }
      declared = field('license');
    } else if (entry.declarationKind === 'project-readme') {
      declared = /^##[^\n]*License\s*\n\s*\n([^\n]+)\s*$/m.exec(original)?.[1];
    }
    if (declared !== entry.declaredLicense) { throw new Error(`Declaration text mismatch: ${entry.name}`); }
    if (inventory && !inventory.packages.some((item) => item.name === entry.name && item.version === entry.version)) {
      throw new Error(`Declaration version absent from target inventory: ${entry.name}@${entry.version}`);
    }
    if (entry.name === pin.engine || entry.name === `${pin.engine}-sdk`) {
      if (entry.source.commit !== pin.commit) { throw new Error(`Declaration source differs from engine pin: ${entry.name}`); }
      const sourcePath = entry.name === pin.engine ? 'README.md' : 'sdk/rust/Cargo.toml';
      if (entry.source.url !== `${pin.repository}/blob/${pin.commit}/${sourcePath}`) {
        throw new Error(`Declaration source URL differs from engine pin: ${entry.name}`);
      }
    }
  }
  if (!packages.has(pin.engine) || !packages.has(`${pin.engine}-sdk`)) {
    throw new Error('Selected engine and SDK declarations are required');
  }
  return ['index.json', ...objects];
}

export function copyNativeDeclarations(
  collection: string, destination: string,
  pin: Pick<SelectedEnginePin, 'engine' | 'repository' | 'commit'>, inventory?: NativeNoticeIndex,
): string[] {
  const files = validateNativeDeclarations(collection, pin, inventory);
  // All inputs are verified before creating an output directory.
  mkdirSync(path.join(destination, 'objects'), { recursive: true });
  for (const file of files) { cpSync(path.join(collection, file), path.join(destination, file)); }
  return files;
}

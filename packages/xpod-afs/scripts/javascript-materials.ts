import type { ProducerBuildTools } from './producer-input';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Both the public library and platform producer preserve the same original materials. */
export function collectAfsJavascriptMaterials(options: {
  buildTools: ProducerBuildTools; packageRoot: string; repoRoot: string; destination: string; target: string;
  library: string; libraryMetafile: string; commands: string; commandsMetafile: string;
  producer: { generatedRoot: string; supplements: string }; vendoredRoots?: string[];
}): void {
  const bunVersion = process.versions.bun ?? 'unknown';
  const originalGenerated = path.join(options.producer.generatedRoot, bunVersion);
  const profile = JSON.parse(readFileSync(path.join(originalGenerated, 'client.json'), 'utf8'));
  const basePrefix = readFileSync(path.join(originalGenerated, profile.file.object), 'utf8');
  if (createHash('sha256').update(basePrefix).digest('hex') !== profile.file.sha256) throw new Error('Client helper source hash mismatch');
  // Only the complete unused declaration may be removed from reviewed bytes.
  const unusedHelper = basePrefix.match(/^var __reExport = \(target, mod, secondTarget\) => \{\n[\s\S]*?^\};\n/mu);
  if (!unusedHelper || basePrefix.indexOf(unusedHelper[0]) !== basePrefix.lastIndexOf(unusedHelper[0])) throw new Error('Reviewed client helper declaration missing or ambiguous');
  const payload = readFileSync(options.library);
  const delimiter = payload.indexOf('\n// ');
  if (delimiter < 0) throw new Error('AFS generated runtime source delimiter missing');
  const actualPrefix = payload.subarray(0, delimiter);
  if (!actualPrefix.equals(Buffer.from(basePrefix.replace(unusedHelper[0], ''))) && !actualPrefix.equals(Buffer.from(basePrefix))) throw new Error('AFS generated runtime differs from reviewed client helpers');
  const generated = path.join(options.destination, 'generated-provenance');
  cpSync(originalGenerated, generated, { recursive: true });
  const prefixHash = createHash('sha256').update(actualPrefix).digest('hex');
  writeFileSync(path.join(generated, 'objects', `${prefixHash}.txt`), actualPrefix);
  const generatedIndex = JSON.parse(readFileSync(path.join(generated, 'index.json'), 'utf8'));
  generatedIndex.prefixSha256 = prefixHash; generatedIndex.prefixBytes = actualPrefix.length;
  generatedIndex.provenance = { original: generatedIndex.provenance, clientProfile: profile.provenance,
    derivation: actualPrefix.equals(Buffer.from(basePrefix)) ? 'Exact reviewed CJS client prefix; full emitted bytes compared.' : 'Exact reviewed CJS client prefix minus the complete unused __reExport declaration; full emitted bytes compared.' };
  generatedIndex.files = [...generatedIndex.files.filter((file: { sourcePath: string }) => file.sourcePath !== 'generated-prefix.js'),
    { sourcePath: 'generated-prefix.js', object: `objects/${prefixHash}.txt`, sha256: prefixHash }];
  writeFileSync(path.join(generated, 'index.json'), JSON.stringify(generatedIndex, null, 2) + '\n');
  const supplements = [options.producer.supplements, path.join(options.packageRoot, 'licenses/javascript')];
  options.buildTools.collectJavascriptNotices({ metafile: options.libraryMetafile, stageRoot: options.packageRoot, repoRoot: options.repoRoot,
    destination: path.join(options.destination, 'library'), target: options.target,
    cli: options.library, bunVersion, supplements, generated,
    vendoredRoots: options.vendoredRoots, requireVendoredOriginals: true });
  // Command SDK/output inputs have their own actual compiler graph and original prefix.
  options.buildTools.collectJavascriptNotices({ metafile: options.commandsMetafile, stageRoot: options.repoRoot, repoRoot: options.repoRoot,
    destination: path.join(options.destination, 'commands'), target: options.target,
    cli: options.commands, bunVersion, supplements, generated: originalGenerated, generatedProfile: 'afs-commands' });
  mkdirSync(options.destination, { recursive: true });
  copyFileSync(path.join(options.repoRoot, 'LICENSE'), path.join(options.destination, 'LICENSE'));
}

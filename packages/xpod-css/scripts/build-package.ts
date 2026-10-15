import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildScopedCssComponents } from './scoped-components';
import { cssPublicationOptions, verifyCssReleaseMaterials } from './publication';
import { cssProducerConfig } from './producer-config';
// One producer owns physical source/dependency staging for CSS and API.
import { packPhysicalModule } from '../../../scripts/lib/physical-module-archive';
import { stagePhysicalService } from '../../../scripts/lib/physical-module-stage';
import { assembleCssNativeRuntime, type CssNativeRuntimeInput } from './native-runtime-material';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const index = process.argv.indexOf('--out');
if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Explicit fresh --out required');
const output = path.resolve(process.argv[index + 1]);
const target = process.platform + '-' + process.arch;
const producerManifest = JSON.parse(readFileSync(path.join(repoRoot, 'packages/xpod-css/package.json'), 'utf8'));
const publication = cssPublicationOptions(process.argv.slice(2), producerManifest.version);
const nativeIndex = process.argv.indexOf('--native-runtime-input');
if (nativeIndex < 0 || !process.argv[nativeIndex + 1] || process.argv[nativeIndex + 1].startsWith('--')) throw new Error('Explicit original --native-runtime-input required');
const nativeInput: CssNativeRuntimeInput = JSON.parse(readFileSync(path.resolve(process.argv[nativeIndex + 1]), 'utf8'));
if (existsSync(output)) throw new Error('Physical stage output already exists');
const componentBase = path.join(repoRoot, '.test-data/css-components-build');
mkdirSync(componentBase, { recursive: true });
const componentWork = mkdtempSync(path.join(componentBase, 'owned-'));
try {
  const generated = await buildScopedCssComponents(repoRoot, path.join(componentWork, 'package'));
  const config = cssProducerConfig(repoRoot, target, generated);
  const facts = stagePhysicalService(repoRoot, output, [config.entry], {
    publication: publication.publication,
    sourceResources: ['package.json', 'bun.lock', 'LICENSE', 'tsconfig.json', '.componentsjs-generator-config.json', 'packages/xpod-css/package.json', 'packages/xpod-css/scripts/build-components.ts', 'packages/xpod-css/scripts/scoped-components.ts', 'packages/xpod-css/scripts/build-package.ts', 'packages/xpod-css/scripts/publication.ts', 'packages/xpod-css/scripts/native-runtime-material.ts', 'scripts/release-gate-evidence.cjs', 'scripts/workspace-package-consumer.cjs', 'scripts/workspace-package-pack.cjs', 'qlever/qlever.lock.json', 'qlever/rdf_protocol/include/xpod_rdf_physical_backend.h', 'packages/xpod-css/scripts/producer-config.ts', 'packages/xpod-css/scripts/component-resources.ts', 'scripts/lib/physical-module-stage.ts', 'scripts/lib/physical-module-archive.ts', 'scripts/lib/physical-module-bins.ts', 'scripts/lib/physical-module-native.ts', 'scripts/lib/physical-module-notices.ts', 'packages/xpod-cli/src/module-catalog.ts', 'packages/xpod-cli/src/source-materials.ts', 'packages/xpod-cli/src/manifest.ts'],
    entry: config.entry, moduleId: config.moduleId, extraSourceRoots: config.extraSourceRoots,
    runtimePackages: ['@solid/community-server', '@undefineds.co/xpod-afs'],
    materializeResources: config.materializeResources,
    manifestFields: config.manifest,
    validateInputs: (inputs: string[]) => {
      const forbidden = inputs.filter(input => /^(?:src\/(?:cli\/|main\.ts|api\/main\.ts|runtime\/(?:service-entry|XpodRuntime)\.ts)|ui\/|desktop\/)/.test(input));
      if (forbidden.length) throw new Error('CSS producer contains service host/UI entry: ' + forbidden.join(','));
    },
  });
  copyFileSync(path.join(generated.metadataRoot, 'scoped-components.json'), path.join(output, 'provenance/css-scoped-components.json'));
  writeFileSync(path.join(output, 'provenance/css-resource-plan.json'), JSON.stringify({ ...config.resourcePlan, ...facts, producerVersion: producerManifest.version, installable: false,
    pending: ['Source/notices/native closure admission', 'Actual Node/Bun ModuleStore HTTP startup and cleanup'] }, null, 2) + '\n');

  const nativeFiles = assembleCssNativeRuntime(output, target, nativeInput);
  writeFileSync(path.join(output, 'provenance/css-native-runtime.json'), JSON.stringify({
    schemaVersion: 1, kind: 'css-native-runtime-byte-binding', target, sourceSha: nativeInput.sourceSha,
    originals: { manifest: nativeInput.manifest, archive: nativeInput.archive, zip: nativeInput.originalZip, acceptance: nativeInput.acceptance },
    files: nativeFiles, officialIdentityAuthenticated: false, releaseAccepted: false,
  }, null, 2) + '\n');

  // Controlled preview packaging uses the same inventory/tar authority as API.
  // Release admission remains separate and fails until original materials close.
  const archiveIndex = process.argv.indexOf('--archive');
  if (archiveIndex >= 0) {
    const archive = process.argv[archiveIndex + 1];
    if (!archive || archive.startsWith('--')) throw new Error('Explicit fresh --archive required');
    const packed = packPhysicalModule(output, path.resolve(archive), { moduleId: config.moduleId, entry: 'entry.mjs', sourceRoot: repoRoot,
      verifyReleaseMaterials: stage => verifyCssReleaseMaterials(stage, publication) });
    process.stdout.write(JSON.stringify({ ...packed, publicationMode: publication.publication.mode, status: publication.publication.mode === 'release' ? 'candidate' : 'controlled-preview', externalAdmission: 'pending', releaseAccepted: false, nativeAdmission: false }) + '\n');
  }

} finally {
  rmSync(componentWork, { recursive: true, force: true });
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScopedCssComponents } from './scoped-components';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const index = process.argv.indexOf('--out');
if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--') || process.argv.lastIndexOf('--out') !== index) {
  throw new Error('Explicit fresh --out required for CSS Components');
}
const result = await buildScopedCssComponents(root, path.resolve(process.argv[index + 1]));
process.stdout.write(JSON.stringify({ metadataRoot: result.metadataRoot, components: result.plan.componentExports.length,
  status: 'generated-metadata', runtimeArchiveAccepted: false }) + '\n');

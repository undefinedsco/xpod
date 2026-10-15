import tsNode from 'ts-node';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)).split(path.sep).join('/');
// Use the declared TS loader while keeping Node's actual node:test runtime and
// each original source URL (factory provenance/import.meta must not be bundled).
const hooks = tsNode.createEsmHooks(tsNode.register({ skipProject: true, transpileOnly: true,
  compilerOptions: { module: 'ESNext', moduleResolution: 'Node', target: 'ES2021', esModuleInterop: true, resolveJsonModule: true },
  moduleTypes: { [root + '**/*.ts']: 'esm' }, experimentalSpecifierResolution: 'node' }));
export const resolve = hooks.resolve;
export async function load(url, context, next) {
  // Existing build-tool TS JSON imports predate Node import attributes.
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
  return hooks.load(url, context, next);
}

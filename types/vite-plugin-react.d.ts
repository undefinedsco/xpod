import type { PluginOption } from 'vite';

/**
 * Stand-in for `@vitejs/plugin-react`'s published types.
 *
 * The package ships `export { … as "module.exports" }` in `dist/index.d.ts`, syntax our
 * TypeScript (5.5) cannot parse. Because one parse error makes `tsc` report syntax only and drop
 * every semantic diagnostic, leaving the real types in the test program turns the whole check
 * into a no-op. The UI is type-checked against the real types by its own build (`ui`: `tsc -b`,
 * `ui/tsconfig.app.json`), so this file only has to describe what `ui/vite.config.ts` uses.
 */
declare function reactPlugin(options?: {
  include?: unknown;
  exclude?: unknown;
  babel?: unknown;
  jsxRuntime?: 'automatic' | 'classic';
  jsxImportSource?: string;
}): PluginOption;

export default reactPlugin;

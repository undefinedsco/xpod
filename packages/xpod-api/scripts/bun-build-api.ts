import type { ApiMetafile } from './bundle-products';

/** Module-local slice only. Full Bun globals change unrelated DOM/Node contracts. */
export interface ApiBunBuildOptions {
  entrypoints: string[];
  target: 'node';
  format: 'esm' | 'cjs';
  external?: string[];
  metafile?: boolean;
  plugins?: Array<{ name: string; setup(build: {
    onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  }): void }>;
}
export interface ApiBunBuildResult {
  success: boolean;
  logs: unknown[];
  outputs: Array<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
  metafile?: ApiMetafile;
}

declare const Bun: { build(options: ApiBunBuildOptions): Promise<ApiBunBuildResult> };

// Actual Bun API, with no alternate compiler/runtime implementation.
export const buildWithBun = Bun.build.bind(Bun);

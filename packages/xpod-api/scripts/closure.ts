import path from 'node:path';
export interface ClosureInput { path: string; bytes: number; }
/** Examine physical inputs, rather than claiming isolation from an entry name. */
export function classifyInputs(inputs: ClosureInput[], repoRoot: string): { inputs: ClosureInput[]; blockers: string[] } {
  const blockers = new Set<string>();
  for (const input of inputs) {
    const relative = path.relative(repoRoot, path.resolve(repoRoot, input.path)).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) blockers.add('input_outside_repository');
    if (/^(?:src\/cli\/|frontend\/|config\/|bin\/)/u.test(relative)) blockers.add(`forbidden_runtime_input:${relative}`);
    if (/^src\/runtime\/(?:bootstrap|lifecycle|XpodRuntime|runner\/node\/CommunitySolidServerCssRunner)\./u.test(relative)) blockers.add(`service_host_input:${relative}`);
    if (/^(?:native\/qlever\/|qlever\/|src\/storage\/rdf\/(?:LocalQleverNativeSparqlClient|QleverSparqlEngine)\.)/u.test(relative)) blockers.add(`css_storage_input:${relative}`);
    if (/^(?:packages\/xpod-afs\/(?:src\/commands|scripts|tools)|tools\/agentfs)/u.test(relative)) blockers.add(`afs_tool_input:${relative}`);
    if (relative.includes('inngest-cli')) blockers.add('inngest_native_requires_platform_authority');
    if (relative.endsWith('.node')) blockers.add(`native_input_requires_platform_authority:${relative}`);
  }
  return { inputs, blockers: [...blockers].sort() };
}

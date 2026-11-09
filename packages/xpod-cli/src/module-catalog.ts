/** Program capabilities, never user Pod data. One registration per capability. */
export const MODULE_CATALOG = [
  { id: 'css', commands: ['css'], packagePrefix: '@undefineds.co/xpod-css' },
  { id: 'api', commands: ['api'], packagePrefix: '@undefineds.co/xpod-api' },
  { id: 'afs', commands: ['afs', 'agent-fs'], packagePrefix: '@undefineds.co/xpod-afs' },
] as const;
export type ModuleId = typeof MODULE_CATALOG[number]['id'];
export const MODULE_API_VERSION = 1;

/** Supported artifact targets, shared by installation and release tooling. */
export const MODULE_TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
] as const;
export type ModuleTarget = typeof MODULE_TARGETS[number];

export function moduleTarget(platform: string, arch: string): ModuleTarget | undefined {
  return MODULE_TARGETS.find(target => target.platform === platform && target.arch === arch);
}

export function modulePackageName(input: string, platform: string, arch: string): string | undefined {
  const definition = moduleDefinition(input);
  const target = moduleTarget(platform, arch);
  return definition && target ? `${definition.packagePrefix}-${target.platform}-${target.arch}` : undefined;
}

export function moduleDefinition(input: string) {
  return MODULE_CATALOG.find(row => row.id === input || (row.commands as readonly string[]).includes(input));
}

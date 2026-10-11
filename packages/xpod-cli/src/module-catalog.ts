/** Program capabilities, never user Pod data. One registration per capability. */
export const MODULE_CATALOG = [
  { id: 'css', commands: ['css'], packagePrefix: '@undefineds.co/xpod-css' },
  { id: 'api', commands: ['api'], packagePrefix: '@undefineds.co/xpod-api' },
  { id: 'afs', commands: ['afs', 'agent-fs'], packagePrefix: '@undefineds.co/xpod-afs' },
] as const;
export type ModuleId = typeof MODULE_CATALOG[number]['id'];
export const MODULE_API_VERSION = 1;

export function moduleDefinition(input: string) {
  return MODULE_CATALOG.find(row => row.id === input || (row.commands as readonly string[]).includes(input));
}

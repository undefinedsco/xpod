import catalog from './module-catalog.json';
/** Program capabilities, never user Pod data. Shared by the host and release tools. */
export type ModuleId = keyof typeof catalog;
export const MODULE_CATALOG = (Object.keys(catalog) as ModuleId[]).map(id => ({ id, ...catalog[id] }));
export const MODULE_API_VERSION = 1;
export function moduleDefinition(input: string) {
  return MODULE_CATALOG.find(row => row.id === input || row.commands.includes(input));
}

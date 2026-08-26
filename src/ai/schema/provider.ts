import { aiProviderResource } from '@undefineds.co/models';

export const Provider = aiProviderResource as any;
Provider.setSparqlEndpoint('/settings/-/sparql');

export type ProviderRow = typeof Provider.$inferSelect;
export type ProviderInsert = typeof Provider.$inferInsert;

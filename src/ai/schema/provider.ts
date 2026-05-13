import { aiProviderResource } from '@undefineds.co/models';

export const Provider = aiProviderResource as any;

export type ProviderRow = typeof Provider.$inferSelect;
export type ProviderInsert = typeof Provider.$inferInsert;

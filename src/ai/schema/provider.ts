import { aiProviderTable } from '@undefineds.co/models';

export const Provider = aiProviderTable as any;

export type ProviderRow = typeof Provider.$inferSelect;
export type ProviderInsert = typeof Provider.$inferInsert;

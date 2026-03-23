import { relations } from '@undefineds.co/drizzle-solid';
import { aiModelTable, aiProviderTable } from '@undefineds.co/models';

export const Model = aiModelTable as any;
const Provider = aiProviderTable as any;

export type ModelRow = typeof Model.$inferSelect;
export type ModelInsert = typeof Model.$inferInsert;

export const ModelRelations = relations(Model, ({ one }) => ({
  provider: one(Provider, {
    fields: [Model.isProvidedBy],
    references: [Provider.id as any],
  }),
}));

export const ProviderRelations = relations(Provider, ({ many }) => ({
  models: many(Model, {
    fields: [Provider.hasModel],
    references: [Model.id as any],
  }),
}));

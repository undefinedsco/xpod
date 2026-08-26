import { relations } from '@undefineds.co/drizzle-solid';
import { aiModelResource } from '@undefineds.co/models';
import { Provider } from './provider';

export const Model = aiModelResource as any;
Model.setSparqlEndpoint('/settings/-/sparql');

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

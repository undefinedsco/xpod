import { relations } from '@undefineds.co/drizzle-solid';
import { aiProviderResource } from '@undefineds.co/models';
import { Model } from '../../ai/schema/model';

/**
 * 运行时类型（Agent SDK 类型）
 */
export enum RuntimeKind {
  CODEBUDDY = 'codebuddy',
  CLAUDE = 'claude',
}

export const Provider = aiProviderResource as any;

/**
 * Provider -> Model 关系定义
 */
export const ProviderRelations = relations(Provider, ({ one }) => ({
  model: one(Model, {
    fields: [Provider.defaultModel],
    references: [Model.id as any],
  }),
}));

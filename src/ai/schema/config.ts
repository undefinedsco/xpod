import { aiConfigResource } from '@undefineds.co/models';

export const AIConfig = aiConfigResource as any;

export type AIConfigRow = typeof AIConfig.$inferSelect;
export type AIConfigInsert = typeof AIConfig.$inferInsert;

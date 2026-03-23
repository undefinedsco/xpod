import { linxSchema } from '@undefineds.co/models';

export const AIConfig = linxSchema.aiConfigTable as any;

export type AIConfigRow = typeof AIConfig.$inferSelect;
export type AIConfigInsert = typeof AIConfig.$inferInsert;

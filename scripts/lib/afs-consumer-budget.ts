/** Node, Bun, supervisors and Matrix share the CJS projection of reviewed JSON. */
export interface AfsConsumerBudget {
  readonly stage: 'prepublish' | 'postpublish';
  readonly hostSetupSeconds: number;
  readonly hostFinalizationSeconds: number;
  readonly uploadWindowSeconds: number;
  readonly registryReadbackSeconds: number;
  readonly registrySingleflightSeconds: number;
  readonly safeExportSeconds: number;
  readonly commandOwnedCloseSeconds: number;
  readonly fullMountedCommandSeconds: number;
  readonly ordinaryCommandSeconds: number;
  readonly consumerRunSeconds: number;
  readonly maximumDurationSeconds: number;
  readonly hostJobMinutes: number;
}
const projection = require('./afs-consumer-budget.cjs') as {
  afsConsumerBudget(stage?: 'prepublish' | 'postpublish'): AfsConsumerBudget;
};
export const afsConsumerBudget = projection.afsConsumerBudget;

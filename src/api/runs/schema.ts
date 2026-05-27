import {
  RunStatus,
  RunStepType,
  runResource,
  runStepResource,
  type RunRow,
  type RunStatusType,
  type RunStepRow,
  type RunStepTypeValue,
} from '@undefineds.co/models';

export const Run = runResource;
export const RunStep = runStepResource;

export { RunStatus, RunStepType };

export const XpodRunStepType = {
  ...RunStepType,
  WAITING_INPUT: 'runtime.waiting_input',
  CONTINUE_REQUESTED: 'run.continue_requested',
} as const;

export type XpodRunStepTypeValue = (typeof XpodRunStepType)[keyof typeof XpodRunStepType];

export type RunRecord = RunRow;
export type RunStepRecord = RunStepRow;
export type {
  RunStatusType,
  RunStepTypeValue,
};

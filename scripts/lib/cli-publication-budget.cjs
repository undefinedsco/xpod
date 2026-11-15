'use strict';
const limits = require('./module-artifact-limits.json');

// These are failure envelopes, not predictions of runner or network speed.
// The supervisor's existing hard ceiling is 600s and its TERM/KILL grace is 2s.
function publicationBudget(coreCommands) {
  if (!Number.isSafeInteger(coreCommands) || coreCommands < 1 || coreCommands > 32) throw new Error('Invalid publication recipe command count');
  const coreCommandMs = 180000;
  const captureCommandMs = Math.min(limits.captureTimeoutMs, 600000);
  const captureCommands = 2, terminationGraceMs = 2000;
  const synchronousAllowanceMs = 300000;
  const commandWindowMs = coreCommands * coreCommandMs + captureCommands * captureCommandMs;
  const producerWindowMs = commandWindowMs + (coreCommands + captureCommands) * terminationGraceMs + synchronousAllowanceMs;
  const minutes = ms => Math.ceil(ms / 60000);
  const steps = Object.freeze({ checkout: 5, setupBun: 5, setupNode: 5, bindCheckout: 1, producerContracts: 2,
    publicationBuild: minutes(producerWindowMs) + 1, publicationUpload: 10 });
  const jobFinalizationMinutes = 1;
  return Object.freeze({ coreCommands, captureCommands, coreCommandMs, captureCommandMs, terminationGraceMs,
    synchronousAllowanceMs, commandWindowMs, producerWindowMs, steps,
    standalonePublicationJobMinutes: Object.values(steps).reduce((sum, value) => sum + value, jobFinalizationMinutes),
  });
}
function createPublicationDeadline(budget, now = Date.now) {
  const started = now();
  return Object.freeze({
    assertRemaining() { if (now() - started >= budget.producerWindowMs) throw new Error('Publication cumulative deadline exceeded'); },
    commandTimeout(kind) {
      const remaining = budget.producerWindowMs - (now() - started) - budget.terminationGraceMs;
      if (remaining < 1) throw new Error('Publication cumulative command window exhausted');
      return Math.min(kind === 'capture' ? budget.captureCommandMs : budget.coreCommandMs, remaining);
    },
  });
}
module.exports = { publicationBudget, createPublicationDeadline };

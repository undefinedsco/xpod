'use strict';
const { PUBLICATION_BUDGET: cli } = require('../check-cli-publication.cjs');
const minutes = ms => Math.ceil(ms / 60000);
// The legacy parent includes the normal CLI producer, a Node probe, and normal AFS
// packaging. Sourcekit capture remains charged to the CLI's single authority.
const cliParentMs = cli.producerWindowMs + cli.terminationGraceMs;
const producerWindowMs = cliParentMs + 2 * (cli.coreCommandMs + cli.terminationGraceMs) + cli.synchronousAllowanceMs;
const steps = Object.freeze({ checkout: cli.steps.checkout, setupBun: cli.steps.setupBun, setupNode: cli.steps.setupNode,
  install: minutes(cli.coreCommandMs), produce: minutes(producerWindowMs) + 1,
  upload: cli.steps.publicationUpload, fullOriginalsUpload: cli.steps.publicationUpload, diagnosticsUpload: cli.steps.publicationUpload });
const NORMAL_SUPPLY_BUDGET = Object.freeze({ cliParentMs, producerWindowMs, steps,
  jobMinutes: Object.values(steps).reduce((sum, value) => sum + value, 1) });
module.exports = { NORMAL_SUPPLY_BUDGET };

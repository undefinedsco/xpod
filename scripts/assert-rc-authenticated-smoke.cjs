#!/usr/bin/env node
const fs = require('node:fs');

const REQUIRED_REQUIREMENT_IDS = [ 'solid-pod-isolation', 'browser-visual' ];

function assertRcAuthenticatedSmoke(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.items)) {
    throw new Error('acceptance report items are required');
  }

  return REQUIRED_REQUIREMENT_IDS.map((requirementId) => {
    const item = report.items.find((candidate) => candidate?.requirementId === requirementId);
    if (!item) {
      throw new Error(`${requirementId} item is required`);
    }
    if (item.status !== 'pass') {
      throw new Error(`${requirementId} must be pass, got ${item.status ?? '(missing)'}`);
    }
    if (!item.commandResult || typeof item.commandResult !== 'object') {
      throw new Error(`${requirementId} commandResult is required`);
    }
    if (item.commandResult.exitCode !== 0) {
      throw new Error(`${requirementId} commandResult.exitCode must be 0`);
    }
    if (item.commandResult.timedOut === true) {
      throw new Error(`${requirementId} command must not time out`);
    }
    return item;
  });
}

function main(argv = process.argv.slice(2)) {
  const reportPath = argv[0];
  if (!reportPath) {
    throw new Error('acceptance report path is required');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assertRcAuthenticatedSmoke(report);
  console.log(`${REQUIRED_REQUIREMENT_IDS.join(', ')} passed`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[assert-rc-authenticated-smoke] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_REQUIREMENT_IDS,
  assertRcAuthenticatedSmoke,
};

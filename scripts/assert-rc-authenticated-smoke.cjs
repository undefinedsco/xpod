#!/usr/bin/env node
const fs = require('node:fs');

const REQUIRED_REQUIREMENT_ID = 'solid-pod-isolation';

function assertRcAuthenticatedSmoke(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.items)) {
    throw new Error('acceptance report items are required');
  }

  const item = report.items.find((candidate) => candidate?.requirementId === REQUIRED_REQUIREMENT_ID);
  if (!item) {
    throw new Error(`${REQUIRED_REQUIREMENT_ID} item is required`);
  }
  if (item.status !== 'pass') {
    throw new Error(`${REQUIRED_REQUIREMENT_ID} must be pass, got ${item.status ?? '(missing)'}`);
  }
  if (!item.commandResult || typeof item.commandResult !== 'object') {
    throw new Error(`${REQUIRED_REQUIREMENT_ID} commandResult is required`);
  }
  if (item.commandResult.exitCode !== 0) {
    throw new Error(`${REQUIRED_REQUIREMENT_ID} commandResult.exitCode must be 0`);
  }
  if (item.commandResult.timedOut === true) {
    throw new Error(`${REQUIRED_REQUIREMENT_ID} command must not time out`);
  }

  return item;
}

function main(argv = process.argv.slice(2)) {
  const reportPath = argv[0];
  if (!reportPath) {
    throw new Error('acceptance report path is required');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assertRcAuthenticatedSmoke(report);
  console.log(`${REQUIRED_REQUIREMENT_ID} passed`);
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
  REQUIRED_REQUIREMENT_ID,
  assertRcAuthenticatedSmoke,
};

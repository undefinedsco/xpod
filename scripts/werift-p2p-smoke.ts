#!/usr/bin/env bun
import {
  formatWeriftP2PSmokeResult,
  parseWeriftP2PSmokeArgs,
  runWeriftP2PSmoke,
  WeriftP2PSmokeUsageError,
  weriftP2PSmokeUsage,
} from '../src/edge/reachability/WeriftP2PSmoke';

async function main(): Promise<void> {
  try {
    const options = parseWeriftP2PSmokeArgs(process.argv.slice(2));
    const result = await runWeriftP2PSmoke(options);
    console.log(formatWeriftP2PSmokeResult(result));
  } catch (error) {
    if (error instanceof WeriftP2PSmokeUsageError) {
      console.log(weriftP2PSmokeUsage());
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();

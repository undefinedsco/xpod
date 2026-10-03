import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  selectTaskModelDiagnosticReceipt,
  type TaskModelFailureDiagnostic,
} from '../../src/util/task-model-diagnostics';

export interface TaskModelDiagnosticProjection {
  receipts: TaskModelFailureDiagnostic[];
  correlatedSessions: Array<{ correlationHash: string; modelReceipts: number; gatewayReceipts: number }>;
  invalidReceiptCount: number;
}

const ANSI_COLOR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const ISO_TIMESTAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})';
const API_TIMESTAMP = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}';
const RECEIPT_ENVELOPE = new RegExp(
  `^(?:(?:${ISO_TIMESTAMP}\\s+)?(?:\\[(?:api|css|gateway|xpod)\\]\\s+)?`
  + `${API_TIMESTAMP}(?:\\s+\\[Req:[A-Za-z0-9_.:-]{1,128}\\])?`
  // CSS installs its logger in full runtimes. Require both Docker and inner timestamps.
  + `|${ISO_TIMESTAMP}\\s+(?:\\[(?:api|css|gateway|xpod)\\]\\s+)?${ISO_TIMESTAMP})\\s+`
  + '\\[(PiAgentRuntimeDriver|AiGatewayHandler|ApiServer)\\]\\s+(?:\\{(?:Primary|W[0-9]+)\\}\\s+)?error:\\s+(\\{.*)$', 'u',
);

/** Parse only trusted logger envelopes and return the shared fixed field allowlist. */
export function projectTaskModelDiagnosticLog(logs: string): TaskModelDiagnosticProjection {
  const receipts: TaskModelFailureDiagnostic[] = [];
  let invalidReceiptCount = 0;
  for (const rawLine of logs.split('\n')) {
    const line = rawLine.replace(ANSI_COLOR_SEQUENCE, '');
    const match = line.match(RECEIPT_ENVELOPE);
    if (!match) continue;
    let value: unknown;
    try { value = JSON.parse(match[2]); } catch { invalidReceiptCount++; continue; }
    const selected = selectTaskModelDiagnosticReceipt(value);
    const expectedEvent = match[1] === 'PiAgentRuntimeDriver' ? 'xpod.task-model-diagnostic'
      : match[1] === 'ApiServer' ? 'xpod.task-gateway-http-diagnostic' : 'xpod.task-gateway-diagnostic';
    if (!selected || selected.event !== expectedEvent) { invalidReceiptCount++; continue; }
    receipts.push(selected);
  }
  const sessions = new Map<string, { correlationHash: string; modelReceipts: number; gatewayReceipts: number }>();
  for (const receipt of receipts) {
    const row = sessions.get(receipt.correlationHash)
      ?? { correlationHash: receipt.correlationHash, modelReceipts: 0, gatewayReceipts: 0 };
    if (receipt.event === 'xpod.task-model-diagnostic') row.modelReceipts++;
    else row.gatewayReceipts++;
    sessions.set(receipt.correlationHash, row);
  }
  return { receipts, correlatedSessions: [...sessions.values()].filter(row => row.modelReceipts > 0 && row.gatewayReceipts > 0),
    invalidReceiptCount };
}

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Task diagnostic projection requires input and output paths');
  let logs = '';
  try { logs = await readFile(input, 'utf8'); } catch { /* Missing logs do not prove model traffic. */ }
  const evidence = {
    schemaVersion: 1, sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    purpose: 'task-model-failure-diagnostic', accepted: false, logsPresent: Boolean(logs),
    ...projectTaskModelDiagnosticLog(logs),
  };
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.stderr.write('Task diagnostic projection failed\n'); process.exitCode = 1; });
}

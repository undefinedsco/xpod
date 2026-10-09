import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Exercise the executable script's actual request function without booting its Gateway fixture.
const source = readFileSync(path.resolve('scripts/accept-matrix-collaboration.ts'), 'utf8');
const ast = ts.createSourceFile('accept-matrix.ts', source, ts.ScriptTarget.Latest, true);
let requestSource = '';
function findRequest(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'api') requestSource = node.getText(ast);
  ts.forEachChild(node, findRequest);
}
findRequest(ast);
if (!requestSource) throw new Error('Matrix acceptance request function is missing');
const javascript = ts.transpileModule(`${requestSource}\napi;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
}).outputText;

async function failure(options: { diag?: boolean; abort?: boolean; unknown?: boolean; monotonicMs?: number } = {}) {
  const controller = new AbortController();
  const records: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const order: string[] = [];
  let wall = 0;
  let monotonic = 0;
  let performanceReads = 0;
  let timeoutBudget: number | undefined;
  const error = Object.assign(new Error('private-secret-marker'), {
    name: 'TimeoutError', cause: { code: options.unknown ? 'private-secret-marker' : 'UND_ERR_HEADERS_TIMEOUT' },
  });
  const api = runInNewContext(javascript, {
    DIAG: options.diag !== false, REQUEST_BUDGET_MS: 300_000, diagSeq: 0,
    base: 'https://gateway.example', headers: {}, inflight: new Map(), URL, Error,
    AcceptanceError: Error,
    Date: { now: () => wall },
    performance: { now: () => { performanceReads += 1; return monotonic; } },
    AbortSignal: { timeout: (budget: number) => { order.push('signal'); timeoutBudget = budget; return controller.signal; } },
    diagLog: (event: string, fields: Record<string, unknown>) => { order.push(event); records.push({ event, fields }); },
    fetch: async (_input: URL, init: RequestInit) => {
      order.push('fetch');
      expect(init.signal).toBe(controller.signal);
      wall = 248_862;
      monotonic = options.monotonicMs ?? 248_862;
      if (options.abort) controller.abort(new DOMException('private-secret-marker', options.unknown ? 'PrivateSecret' : 'TimeoutError'));
      throw error;
    },
  }) as (route: string, method: string, body?: unknown) => Promise<unknown>;
  await expect(api('/_matrix/client/v3/rooms/room/send/m.room.message/txn', 'PUT', { body: 'private-secret-marker' }))
    .rejects.toThrow('TimeoutError; request budget 300s');
  return { records, order, timeoutBudget, performanceReads };
}

describe('Matrix opt-in request failure diagnostics', () => {
  it('distinguishes a fetch timeout from an unexpired request AbortSignal', async () => {
    const result = await failure();
    expect(result.records[1]).toMatchObject({ event: 'FAIL', fields: {
      kind: 'TimeoutError', durationMs: 248_862, monotonicDurationMs: 248_862,
      signalAborted: false, signalReasonName: null, causeCode: 'UND_ERR_HEADERS_TIMEOUT',
    } });
    expect(result.order.slice(0, 3)).toEqual(['START', 'signal', 'fetch']);
    expect(result.timeoutBudget).toBe(300_000);
  });

  it('records an actual signal abort and monotonic duration separately from wall time', async () => {
    const result = await failure({ abort: true, monotonicMs: 300_000 });
    expect(result.records[1].fields).toMatchObject({
      signalAborted: true, signalReasonName: 'TimeoutError', durationMs: 248_862, monotonicDurationMs: 300_000,
    });
  });

  it('projects unknown reason and cause codes without free error text or request content', async () => {
    const result = await failure({ abort: true, unknown: true });
    expect(result.records[1].fields).toMatchObject({ signalReasonName: 'other', causeCode: 'unknown' });
    expect(JSON.stringify(result.records)).not.toContain('private-secret-marker');
    expect(JSON.stringify(result.records)).not.toContain('PrivateSecret');
  });

  it('keeps diagnostics off without extra performance reads or diagnostic records', async () => {
    const result = await failure({ diag: false });
    expect(result.records).toEqual([]);
    expect(result.performanceReads).toBe(0);
    expect(result.timeoutBudget).toBe(300_000);
    expect(result.order).toEqual(['signal', 'fetch']);
  });
});

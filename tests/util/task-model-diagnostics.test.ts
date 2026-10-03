import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashTaskModelDiagnosticSession,
  selectTaskModelDiagnosticReceipt,
} from '../../src/util/task-model-diagnostics';

const session = 'xpod-' + 'a'.repeat(64);
const correlationHash = createHash('sha256').update(session).digest('hex');
const model = {
  event: 'xpod.task-model-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
  stage: 'payload_prepared', api: 'openai-completions', stopReason: 'error',
  retryCount: 0, credentialPresent: true, httpStatus: null,
};
const gateway = {
  event: 'xpod.task-gateway-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
  route: 'chat_completions', callerHTTPstatus: 200, code: 'provider_error',
  underlyingErrorStatus: 502, streamOpen: true, durationMs: 120,
};

describe('safe Task model receipt contract', () => {
  it('hashes the exact session header and rejects missing, oversized or malformed values', () => {
    expect(hashTaskModelDiagnosticSession(session)).toBe(correlationHash);
    for (const value of [undefined, null, 1, '', ' xpod-a', 'xpod-a ', 'xpod\na', 'x'.repeat(257)]) {
      expect(hashTaskModelDiagnosticSession(value)).toBeUndefined();
    }
  });

  it('selects only fixed fields without changing unknown HTTP into a measured status', () => {
    const selected = selectTaskModelDiagnosticReceipt({ ...model,
      apiKey: 'secret-sentinel', errorMessage: 'raw-sentinel', payload: { password: 'secret-sentinel' },
    });
    expect(selected).toEqual(model);
    expect(JSON.stringify(selected)).not.toMatch(/sentinel|"password"|"payload"|"apiKey"|"errorMessage"/);
    expect(selectTaskModelDiagnosticReceipt({ ...model, httpStatus: 503 })).toBeUndefined();
  });

  it('keeps actual caller status distinct from a structured stream failure status', () => {
    expect(selectTaskModelDiagnosticReceipt(gateway)).toEqual(gateway);
    const { underlyingErrorStatus, ...withoutUnderlying } = gateway;
    expect(underlyingErrorStatus).toBe(502);
    expect(selectTaskModelDiagnosticReceipt(withoutUnderlying)).toEqual(withoutUnderlying);
    expect(selectTaskModelDiagnosticReceipt({ ...gateway, underlyingErrorStatus: '502' })).toBeUndefined();
  });

  it('selects a completed HTTP rejection without inventing a normalized upstream error', () => {
    const http = { event: 'xpod.task-gateway-http-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
      route: 'chat_completions', callerHTTPstatus: 401, statusSource: 'response_finished', durationMs: 1 };
    expect(selectTaskModelDiagnosticReceipt({ ...http, responseBody: 'secret-sentinel' })).toEqual(http);
    expect(selectTaskModelDiagnosticReceipt({ ...http, callerHTTPstatus: 200 })).toBeUndefined();
    expect(selectTaskModelDiagnosticReceipt({ ...http, statusSource: 'not_sent' })).toBeUndefined();
  });

  it('rejects invalid enums, scopes, hashes, types and number bounds', () => {
    for (const changed of [
      { stage: 'request_sent' }, { api: 'free-provider' }, { stopReason: 'free-error' },
      { retryCount: -1 }, { retryCount: 0.5 }, { retryCount: Infinity },
      { scope: 'run' }, { schemaVersion: 2 }, { correlationHash: 'a'.repeat(63) },
      { correlationHash: 'A'.repeat(64) }, { credentialPresent: 'true' },
    ]) expect(selectTaskModelDiagnosticReceipt({ ...model, ...changed })).toBeUndefined();
    for (const changed of [
      { code: 'secret-sentinel' }, { route: '/free/path' }, { callerHTTPstatus: 99 },
      { callerHTTPstatus: 600 }, { durationMs: -1 }, { durationMs: 2147483648 },
      { durationMs: NaN }, { streamOpen: 1 },
    ]) expect(selectTaskModelDiagnosticReceipt({ ...gateway, ...changed })).toBeUndefined();
    for (const value of [null, undefined, [], 'secret-sentinel']) {
      expect(selectTaskModelDiagnosticReceipt(value)).toBeUndefined();
    }
  });
});

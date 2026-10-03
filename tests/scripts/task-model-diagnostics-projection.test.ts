import { describe, expect, it, vi } from 'vitest';
import { projectTaskModelDiagnosticLog } from '../../scripts/helpers/project-task-model-diagnostics';
import { ConfigurableLoggerFactory } from '../../src/logging/ConfigurableLoggerFactory';
import { logContext } from '../../src/logging/LogContext';

// Exercise the production formatter without opening a rotating file transport.
vi.mock('winston-daily-rotate-file', () => ({ default: class {
  public setMaxListeners(): this { return this; }
} }));

class FormatterFactory extends ConfigurableLoggerFactory {
  public formatReceipt(component: string, receipt: unknown): string {
    const formatter = this.getFormat(component);
    const transformed = formatter.transform({ level: 'error', message: JSON.stringify(receipt) }, formatter.options);
    if (!transformed || typeof transformed !== 'object' || typeof transformed[Symbol.for('message')] !== 'string') throw new Error('Missing formatted receipt');
    return transformed[Symbol.for('message')] as string;
  }
}

const correlationHash = 'a'.repeat(64);
const model = {
  event: 'xpod.task-model-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
  stage: 'stream_open', api: 'openai-completions', stopReason: 'error',
  retryCount: 1, credentialPresent: true, httpStatus: null,
  sdkErrorHint: { kind: 'http_status', status: 503 },
};
const gateway = {
  event: 'xpod.task-gateway-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
  route: 'chat_completions', callerHTTPstatus: 200, code: 'provider_error',
  underlyingErrorStatus: 502, streamOpen: true, durationMs: 20,
};
const line = (component: string, value: unknown) =>
  `2026-10-03T14:00:00.000000000Z [api] 2026-10-03 14:00:00 [${component}] error: ${JSON.stringify(value)}`;

describe('Task diagnostic artifact projection', () => {
  it('reads the actual API formatter with its local timestamp and request context', () => {
    const factory = new FormatterFactory('info', { showLocation: true });
    const logs = logContext.run({ requestId: 'controlled-test-request' }, () => [
      factory.formatReceipt('src/api/runs/PiAgentRuntimeDriver', model),
      factory.formatReceipt('src/api/handlers/AiGatewayHandler', gateway),
    ].join('\n'));
    const result = projectTaskModelDiagnosticLog(logs);
    expect(result.receipts).toEqual([model, gateway]);
    expect(result.correlatedSessions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('controlled-test-request');
  });

  it('pairs fixed producer receipts at session scope, preserving SSE caller 200', () => {
    const result = projectTaskModelDiagnosticLog([
      line('PiAgentRuntimeDriver', model), line('AiGatewayHandler', gateway),
    ].join('\n'));
    expect(result.receipts).toEqual([model, gateway]);
    expect(result.correlatedSessions).toEqual([{ correlationHash, modelReceipts: 1, gatewayReceipts: 1 }]);
    expect(result.invalidReceiptCount).toBe(0);
  });

  it('drops free data and rejects untrusted labels, bad JSON and forged field types', () => {
    const result = projectTaskModelDiagnosticLog([
      line('PiAgentRuntimeDriver', { ...model, errorMessage: 'secret-sentinel', apiKey: 'key-sentinel' }),
      line('OtherLogger', gateway), line('AiGatewayHandler', model),
      '2026-10-03 14:00:00 [AiGatewayHandler] error: {"event":"xpod.task-gateway-diagnostic","secret":"malformed-sentinel"',
      line('AiGatewayHandler', { ...gateway, callerHTTPstatus: '502', raw: 'bad-sentinel' }),
      'ordinary output with password secret-sentinel',
    ].join('\n'));
    expect(result.receipts).toEqual([model]);
    expect(result.correlatedSessions).toEqual([]);
    expect(result.invalidReceiptCount).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/sentinel|errorMessage|apiKey|password/);
  });

  it('does not mistake Docker timestamps on bare class output for the API formatter', () => {
    expect(projectTaskModelDiagnosticLog(
      `2026-10-03T14:00:00.000000000Z [AiGatewayHandler] {Primary} error: ${JSON.stringify(gateway)}`,
    ).receipts).toEqual([]);
  });

  it('accepts the runtime CSS formatter only behind a separate Docker timestamp', () => {
    // Full-runtime logs use this envelope after CSS installs its global logger.
    const inner = `[ApiServer] {Primary} error: ${JSON.stringify({
      event: 'xpod.task-gateway-http-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
      route: 'chat_completions', callerHTTPstatus: 401, statusSource: 'response_finished', durationMs: 1,
    })}`;
    const result = projectTaskModelDiagnosticLog(`2026-10-03T15:08:41.417000000Z 2026-10-03T15:08:41.417Z ${inner}`);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({ callerHTTPstatus: 401, statusSource: 'response_finished' });
    expect(projectTaskModelDiagnosticLog(`2026-10-03T15:08:41.417000000Z ${inner}`).receipts).toEqual([]);
  });

  it('requires an inner formatter timestamp and rejects bare or nested logger labels', () => {
    const json = JSON.stringify(gateway);
    const result = projectTaskModelDiagnosticLog([
      `[AiGatewayHandler] {Primary} error: ${json}`,
      `2026-10-03T14:00:00.000000000Z [api] [AiGatewayHandler] error: ${json}`,
      `2026-10-03T14:00:00.000000000Z [OtherLogger] 2026-10-03 14:00:00 [AiGatewayHandler] error: ${json}`,
      line('OtherLogger', gateway),
    ].join('\n'));
    expect(result).toEqual({ receipts: [], correlatedSessions: [], invalidReceiptCount: 0 });
  });

  it('correlates an actual HTTP authentication rejection before the model handler', () => {
    const factory = new FormatterFactory('info', { showLocation: true });
    const http = { event: 'xpod.task-gateway-http-diagnostic', schemaVersion: 1, scope: 'session', correlationHash,
      route: 'chat_completions', callerHTTPstatus: 403, statusSource: 'response_finished', durationMs: 1 };
    const result = projectTaskModelDiagnosticLog([
      factory.formatReceipt('PiAgentRuntimeDriver', model), factory.formatReceipt('ApiServer', http),
    ].join('\n'));
    expect(result.receipts).toEqual([model, http]);
    expect(result.correlatedSessions).toEqual([{ correlationHash, modelReceipts: 1, gatewayReceipts: 1 }]);
  });

  it('never joins different sessions or interprets missing logs as successful model traffic', () => {
    const result = projectTaskModelDiagnosticLog([
      line('PiAgentRuntimeDriver', model),
      line('AiGatewayHandler', { ...gateway, correlationHash: 'b'.repeat(64) }),
    ].join('\n'));
    expect(result.correlatedSessions).toEqual([]);
    expect(projectTaskModelDiagnosticLog('')).toEqual({ receipts: [], correlatedSessions: [], invalidReceiptCount: 0 });
  });
});

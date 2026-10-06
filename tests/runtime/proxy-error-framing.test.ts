import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { verifyGatewayProxyErrorFraming, verifyGatewayProxyLateError } from '../helpers/gatewayProxyErrorFramingFixture';

const execute = promisify(execFile);

describe('Gateway error response framing', () => {
  it('replaces malformed upstream framing with complete JSON on Node', async () => {
    await verifyGatewayProxyErrorFraming();
    await verifyGatewayProxyErrorFraming(true);
  });
  it('rejects an interrupted body after forwarding its headers on Node', () => verifyGatewayProxyLateError());
  it('replaces malformed upstream framing without writing after end on Bun', async () => {
    await execute('bun', ['tests/helpers/runGatewayProxyErrorFramingFixture.ts'], { timeout: 10_000 });
  });
});

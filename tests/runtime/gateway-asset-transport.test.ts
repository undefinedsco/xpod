import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { gatewayAssetTransportBudgetMs, verifyGatewayAssetTransport } from '../helpers/gatewayAssetTransportFixture';

const execute = promisify(execFile);

describe('Gateway asset responses finish under concurrent browser loads', () => {
  it('completes API and CSS/default asset streams on Node', () => verifyGatewayAssetTransport(10), 40_000);
  it('completes API and CSS/default asset streams on the actual Bun runtime', async () => {
    await execute('bun', ['tests/helpers/runGatewayAssetTransportFixture.ts'], { timeout: gatewayAssetTransportBudgetMs + 5_000 });
  }, gatewayAssetTransportBudgetMs + 10_000);
});

import { gatewayAssetTransportBudgetMs, verifyGatewayAssetTransport } from './gatewayAssetTransportFixture';

const watchdog = setTimeout(() => {
  process.stderr.write('Gateway asset transport fixture timed out\n');
  process.exit(2);
}, gatewayAssetTransportBudgetMs);
void verifyGatewayAssetTransport().then(() => {
  clearTimeout(watchdog);
  process.exit(0);
}, (error: unknown) => {
  clearTimeout(watchdog);
  console.error(error);
  process.exit(1);
});

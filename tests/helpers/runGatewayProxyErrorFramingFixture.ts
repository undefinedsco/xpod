import { verifyGatewayProxyErrorFraming, verifyGatewayProxyLateError } from './gatewayProxyErrorFramingFixture';

const watchdog = setTimeout(() => {
  process.stderr.write('Gateway proxy error framing fixture timed out\n');
  process.exit(2);
}, 8_000);
void verifyGatewayProxyErrorFraming().then(() => verifyGatewayProxyErrorFraming(true)).then(() => verifyGatewayProxyLateError()).then(() => {
  clearTimeout(watchdog);
  process.exit(0);
}, (error: unknown) => {
  clearTimeout(watchdog);
  console.error(error);
  process.exit(1);
});

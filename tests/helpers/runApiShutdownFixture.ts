import { verifyInFlightShutdown, verifyUpgradeShutdown, verifyWebSocketLogicalDrain, verifyServerInitiatedWebSocketClose } from './apiShutdownFixture';
const watchdog = setTimeout(() => { process.stderr.write('shutdown fixture timed out\n'); process.exit(2); }, 15_000);
const mode = process.argv[2];
const scenario = mode === 'replacement' || mode === 'heartbeat' ? verifyServerInitiatedWebSocketClose(mode) : mode === 'ws-logical' ? verifyWebSocketLogicalDrain() : mode === 'upgrade' ? verifyUpgradeShutdown() : verifyInFlightShutdown(mode === 'disconnect');
void scenario.then(() => { clearTimeout(watchdog); process.stdout.write(`shutdown ${mode} passed\n`); process.exit(0); }, (error) => {
  clearTimeout(watchdog); process.stderr.write(`${String(error)}\n`); process.exit(1);
});

export type TestRuntimeTransport = 'socket' | 'port';

export function resolveTestRuntimeTransport(
  transport?: TestRuntimeTransport | 'auto',
): TestRuntimeTransport {
  if (transport === 'socket' || transport === 'port') {
    return transport;
  }

  const envTransport = process.env.XPOD_TEST_TRANSPORT;
  if (envTransport === 'socket' || envTransport === 'port') {
    return envTransport;
  }

  return process.platform === 'win32' ? 'port' : 'socket';
}

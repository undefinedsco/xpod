import portfinder from 'portfinder';

/**
 * Find the next available port starting from basePort
 */
export async function getFreePort(basePort: number): Promise<number> {
  portfinder.basePort = basePort;
  return portfinder.getPortPromise();
}

import type { ExternalLoginProvider } from './ExternalLoginProvider';

export interface ExternalLoginEntry {
  readonly id: string;
  readonly connector: string;
  readonly name?: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** A connector implementation owns its protocol, config and stable identity scope. */
export interface ExternalLoginConnectorFactory {
  readonly id: string;
  create(entry: ExternalLoginEntry): ExternalLoginProvider;
}

/** Vendor-neutral creation boundary. All connectors implement the same provider interface. */
export class ExternalLoginProviderFactory {
  private readonly connectors = new Map<string, ExternalLoginConnectorFactory>();

  public constructor(connectors: readonly ExternalLoginConnectorFactory[] = []) {
    for (const connector of connectors) this.register(connector);
  }

  public register(connector: ExternalLoginConnectorFactory): void {
    if (!/^[a-z][a-z0-9-]*$/u.test(connector.id)) throw new Error('Invalid external login connector ID');
    if (this.connectors.has(connector.id)) throw new Error(`Duplicate external login connector: ${connector.id}`);
    this.connectors.set(connector.id, connector);
  }

  public create(entry: ExternalLoginEntry): ExternalLoginProvider {
    if (!/^[a-z][a-z0-9-]*$/u.test(entry.id)) throw new Error('Invalid external login entry ID');
    const connector = this.connectors.get(entry.connector);
    if (!connector) throw new Error(`External login connector is not registered: ${entry.connector}`);
    const provider = connector.create(Object.freeze({ ...entry, config: Object.freeze({ ...entry.config }) }));
    if (provider.id !== entry.id || !provider.provider || !provider.namespace || !provider.name) {
      throw new Error('External login connector returned an invalid provider');
    }
    return provider;
  }
}

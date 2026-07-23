export interface RootKeyMaterial {
  keyId: string;
  key: Uint8Array;
}

export interface DeploymentRootKeyProviderOptions {
  activeKeyId: string;
  keys: Record<string, Uint8Array>;
}

export class DeploymentRootKeyProvider {
  private readonly activeKeyId: string;
  private readonly keys = new Map<string, Uint8Array>();

  public constructor(options: DeploymentRootKeyProviderOptions) {
    if (!options.activeKeyId) {
      throw new Error('SecretCell active keyId is required');
    }
    for (const [keyId, key] of Object.entries(options.keys)) {
      if (!keyId) {
        throw new Error('SecretCell keyId is required');
      }
      if (key.byteLength !== 32) {
        throw new Error(`SecretCell root key ${keyId} must be 32 bytes`);
      }
      this.keys.set(keyId, new Uint8Array(key));
    }
    if (!this.keys.has(options.activeKeyId)) {
      throw new Error(`SecretCell active root key ${options.activeKeyId} is not configured`);
    }
    this.activeKeyId = options.activeKeyId;
  }

  public getActiveKey(): RootKeyMaterial {
    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      throw new Error('SecretCell active root key is not available');
    }
    return { keyId: this.activeKeyId, key: new Uint8Array(key) };
  }

  public getActiveKeyId(): string {
    return this.activeKeyId;
  }

  public getKey(keyId: string): RootKeyMaterial | undefined {
    const key = this.keys.get(keyId);
    return key ? { keyId, key: new Uint8Array(key) } : undefined;
  }
}

export function parseDeploymentRootKeyConfig(value: string): Uint8Array {
  if (!isStrictBase64(value)) {
    throw new Error('SecretCell root key must be strict base64');
  }
  const decoded = new Uint8Array(Buffer.from(value, 'base64'));
  if (decoded.byteLength !== 32) {
    decoded.fill(0);
    throw new Error('SecretCell root key must decode to 32 bytes');
  }
  return decoded;
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

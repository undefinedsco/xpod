export interface EdgeNodeCertificateRuntime {
  readCertificateStatus(): Promise<unknown>;
  renewCertificate(): Promise<unknown>;
  isAvailable?(): boolean | Promise<boolean>;
}

export interface EdgeNodeCertificateBridgeStatus {
  supported: boolean;
  status: string;
  expiresAt?: string;
}

type CertificateRuntimeSupplier = () => EdgeNodeCertificateRuntime | undefined;
type BridgeDisposer = () => void;

export class EdgeNodeCertificateCapabilityBridge {
  private readonly id: string;
  private supplier?: CertificateRuntimeSupplier;
  private sourceLease?: symbol;
  private consumerCount = 0;

  public constructor(id: string) {
    this.id = id;
  }

  public retain(): BridgeDisposer {
    this.consumerCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.consumerCount = Math.max(0, this.consumerCount - 1);
      this.deleteIfIdle();
    };
  }

  public setSource(supplier: CertificateRuntimeSupplier): BridgeDisposer {
    const lease = Symbol(this.id);
    this.supplier = supplier;
    this.sourceLease = lease;
    return () => {
      if (this.sourceLease !== lease) {
        return;
      }
      this.clearSource();
    };
  }

  public clearSource(): void {
    this.supplier = undefined;
    this.sourceLease = undefined;
    this.deleteIfIdle();
  }

  public async isAvailable(): Promise<boolean> {
    const runtime = this.supplier?.();
    if (!runtime) {
      return false;
    }
    if (typeof runtime.isAvailable === 'function') {
      return Boolean(await runtime.isAvailable());
    }
    return true;
  }

  public async readCertificateStatus(): Promise<EdgeNodeCertificateBridgeStatus | unknown> {
    const runtime = this.supplier?.();
    if (!runtime) {
      return { supported: false, status: 'unsupported' };
    }
    const status = await runtime.readCertificateStatus();
    if (!status || typeof status !== 'object' || Array.isArray(status) || 'supported' in status) {
      return status;
    }
    return {
      supported: true,
      ...status as Record<string, unknown>,
    };
  }

  public async renewCertificate(): Promise<unknown> {
    const runtime = this.supplier?.();
    if (!runtime) {
      throw Object.assign(new Error('Certificate runtime is not available.'), {
        statusCode: 503,
        code: 'certificate_renewal_unavailable',
      });
    }
    return await runtime.renewCertificate();
  }

  private deleteIfIdle(): void {
    if (!this.supplier && this.consumerCount === 0) {
      bridges.delete(this.id);
    }
  }
}

const bridges = new Map<string, EdgeNodeCertificateCapabilityBridge>();

export function getEdgeNodeCertificateCapabilityBridge(id: string): EdgeNodeCertificateCapabilityBridge {
  let bridge = bridges.get(id);
  if (!bridge) {
    bridge = new EdgeNodeCertificateCapabilityBridge(id);
    bridges.set(id, bridge);
  }
  return bridge;
}

export function hasEdgeNodeCertificateCapabilityBridge(id: string): boolean {
  return bridges.has(id);
}

export function resolveEdgeNodeCertificateCapabilityBridgeId(input: {
  nodeId?: string;
  baseUrl?: string;
}): string | undefined {
  if (input.nodeId?.trim()) {
    return `node:${input.nodeId.trim()}`;
  }
  if (input.baseUrl?.trim()) {
    try {
      return `base:${new URL(input.baseUrl).origin}`;
    } catch {
      return `base:${input.baseUrl.trim()}`;
    }
  }
  return undefined;
}

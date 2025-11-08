export interface EdgeNodeCertificateProvisioner {
  handleCertificateRequest(nodeId: string, metadata: Record<string, unknown>): Promise<void>;
}

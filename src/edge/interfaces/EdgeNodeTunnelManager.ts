export interface EdgeNodeTunnelManager {
  /**
   * 根据当前 metadata 判断是否需要建立/更新隧道，当返回对象时表示需要写回 metadata。
   */
  ensureConnectivity(nodeId: string, metadata: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}
import { describe, it } from 'vitest';

/**
 * NOTE:
 * 这里保留真正的「双 Cloud/Center 节点」测试位。
 * 当前 docker-compose.cluster.yml 只定义单 Cloud，
 * 因此先整体 skip，避免误导成“已覆盖多中心路由/迁移”。
 *
 * 后续恢复条件：
 * 1) 提供双 center/cloud 的 docker 拓扑（共享身份库 + 路由链路）
 * 2) 打开 XPOD_RUN_DOCKER_MULTINODE_TESTS=true
 */
describe.skip('Multi-node Center Cluster (requires dual-cloud topology)', () => {
  it('should register both centers and route pod requests cross-node', () => {
    // implemented once dual-cloud docker topology is available
  });

  it('should support heartbeat and migration flows across centers', () => {
    // implemented once dual-cloud docker topology is available
  });
});

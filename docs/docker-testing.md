# 集成测试分层（当前）

## 1) Lite（默认，非 Docker）
- 命令：`bun run test:integration:lite`
- 运行方式：
  - 本地自动启动 `xpod`（`config/local.json`）
  - 自动选择可用传输（默认 Unix socket；Bun / Windows 下走随机端口）
  - 自动执行 `bun run test:setup` 生成最新 `SOLID_*` 凭据
  - 执行 `tests/integration/**`，排除集群/Docker 专用用例
- 门禁：`XPOD_RUN_INTEGRATION_TESTS=true`

适用场景：日常开发、快速回归、端口冲突场景。

## 2) Full（按需）
- 命令：`bun run test:integration:full`
- 运行方式：
  - 启动或复用本地 `postgres` / `redis` / `minio`
  - 以 runtime 方式拉起 cloud / cloud_b / local / standalone
  - 自动执行 `bun run test:setup`
  - 只执行 full 目标用例：`DockerCluster` / `MultiNodeCluster` / `ProvisionFlow` / `CloudQuotaBusinessToken`

适用场景：发布前验证、跨节点/集群改动验证。

## 3) Bun Runtime Smoke
- 命令：`bun run test:bun:runtime`
- 运行方式：
  - 先执行 `bun run build:ts`
  - 使用 Bun 直接启动 runtime smoke 脚本
  - 覆盖 open runtime，以及 auth + vector 闭环

适用场景：验证 Bun 兼容性，不替代完整 Node 集成测试。

## 常用命令

```bash
# 默认集成（lite + full）
bun run test:integration

# 轻量（本地自动拉起 xpod）
bun run test:integration:lite

# 完整
bun run test:integration:full

# Bun 冒烟
bun run test:bun:runtime
```

## 备注
- Bun 当前只提供 runtime smoke，不走 `vitest --bun`。
- 如果需要强制指定传输，可设置 `XPOD_TEST_TRANSPORT=socket|port`。

## 当前状态

- [x] Lite 路径稳定：可本地自动拉起 xpod 并完成 integration 回归。
- [x] Full 路径稳定：可复用或自动拉起依赖后完成 full 集成回归。
- [x] Bun 路径有独立门禁：当前以 runtime smoke 形式纳入 CI。

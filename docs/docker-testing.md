# 集成测试分层（当前）

## 1) Lite（默认，非 Docker）
- 命令：`yarn test:integration:lite`
- 运行方式：
  - 本地自动启动 `xpod`（`config/local.json`）
  - 自动选择可用端口（默认从 `5739` 开始）
  - 自动执行 `yarn test:setup` 生成最新 `SOLID_*` 凭据
  - 执行 `tests/integration/**`，排除集群/Docker 专用用例
- 门禁：`XPOD_RUN_INTEGRATION_TESTS=true`

适用场景：日常开发、快速回归、端口冲突场景。

## 2) Full（按需）
- 命令：`yarn test:integration:full`
- 说明：用于全量集成回归（包含更重的 integration 组合），通常需要稳定的 Docker/集群环境配合。

适用场景：发布前验证、跨节点/集群改动验证。

## 常用命令

```bash
# 默认集成（等价 full）
yarn test:integration

# 轻量（本地自动拉起 xpod）
yarn test:integration:lite

# 完整
yarn test:integration:full
```

## 备注
- `test:integration:lite` 会在执行前刷新组件描述（`build:components`），避免本地配置与组件 context 漂移导致的启动失败。
- 如果需要强制指定起始端口，可设置 `XPOD_TEST_BASE_URL`（例如 `http://localhost:5739`）。

## 当前状态

- [x] Lite 路径稳定：Node v22 下可本地自动拉起 xpod 并完成 integration 回归（动态端口 + test:setup）。
- [ ] Full 路径待收敛：仍受 Docker/cluster 环境稳定性影响，需要进一步统一 full 的执行口径与门禁策略。

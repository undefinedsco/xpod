# Docker 集成测试分层

为减少本地回归成本，Docker 集成测试分两层执行：

## 1) 轻量层（默认）
- Compose: `docker-compose.standalone.yml`
- 命令：`yarn test:docker`（等价 `yarn test:docker:lite`）
- 执行范围：`tests/integration/**` 全量扫描
- 运行策略：
  - Standalone 相关用例（`XPOD_RUN_DOCKER_LITE_TESTS=true`）会执行
  - 依赖完整集群的用例（`XPOD_RUN_DOCKER_TESTS=true`）会自动跳过

适用场景：日常开发、快速回归。

## 2) 完整层（按需）
- Compose: `docker-compose.cluster.yml`
- 命令：`yarn test:docker:full`
- 执行范围：`tests/integration/**` 全量执行（含 Cloud + Local(SP) + Standalone）
- 环境变量：同时注入 `XPOD_RUN_DOCKER_LITE_TESTS=true` 与 `XPOD_RUN_DOCKER_TESTS=true`

适用场景：发布前验证、跨节点改动验证。

## 常用命令

```bash
# 轻量环境启动/停止
yarn test:docker:lite:up
yarn test:docker:lite:down

# 轻量测试（默认）
yarn test:docker

# 完整测试
yarn test:docker:full

# 两层都跑
yarn test:docker:all
```


## 3) Service 级测试（非 Docker）
- 命令：`yarn test:service`
- 用途：保留 mock 驱动的 API 组合验证，不纳入 Docker 集成门禁。

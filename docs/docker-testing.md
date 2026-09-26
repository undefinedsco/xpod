# 集成测试分层（当前）

## 1) Lite（默认，非 Docker）
- 命令：`bun run test:integration:lite`
- 运行方式：
  - 本地自动启动 `xpod`（`config/local.json`）
  - 自动选择可用传输（默认 Unix socket；Bun / Windows 下走随机端口）
  - 自动执行 `bun run test:setup` 生成最新 `TEST_SOLID_*` 凭据
  - 执行 `tests/integration/**`，排除集群/Docker 专用用例
- 门禁：`XPOD_RUN_INTEGRATION_TESTS=true`

适用场景：日常开发、快速回归、端口冲突场景。

## 2) Full（按需）
- 命令：`bun run test:integration:full`
- 运行方式：
  - 启动或复用本地 `postgres` / `redis` / `minio`（S3 端点由 VersityGW 提供，见下）
  - 以 runtime 方式拉起 cloud / cloud_b / local / standalone
  - 自动执行 `bun run test:setup`
  - 只执行 full 目标用例：`DockerCluster` / `MultiNodeCluster` / `ProvisionFlow` / `CloudQuotaBusinessToken`

适用场景：发布前验证、跨节点/集群改动验证。

### 测试用 S3 端点（VersityGW）

Compose 服务名仍是 `minio`，端口仍是 9000，凭据仍是 `minioadmin`，端点仍是 path-style，
但镜像已从官方 MinIO 换成 [VersityGW](https://github.com/versity/versitygw)：

- 官方镜像无法再匿名拉取：`quay.io/minio/minio` 对原先固定的 index 返回 401，
  `minio/minio` 已从 Docker Hub 下架，`test:integration:full` 会卡在
  `docker compose ... up -d postgres redis minio`。
- VersityGW 是单个静态 Rust 二进制（Apache-2.0，Alpine 底座），提供同样的 path-style S3 API
  （含 presign、multipart、`x-amz-meta-*` 往返、SigV4 校验），因此 `MinioDataAccessor`、
  `CSS_MINIO_*`、测试代码与凭据都不需要改。
- 体积：压缩 ~58 MiB → ~28 MiB，落盘 ~350 MiB → ~93 MiB。
- digest 固定为 v1.8.0 多架构 index（arm64/amd64 均覆盖），需与
  `docker-compose.cluster.yml`、`docker-compose.acceptance.yml`、
  `tests/helpers/dockerObjectStore.ts` 保持一致。
- 镜像内没有 `mc`，也没有 9001 console；健康检查改为探测 9000 端口，
  full runner 改为用 `minio` 客户端做一次带认证的 bucket 探测。
- 测试 bucket 必须预先存在（Xpod 代码不建 bucket）：posix 后端把根目录下的每个子目录当作 bucket，
  所以 compose 在启动前 `mkdir` 出 `xpod`。

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

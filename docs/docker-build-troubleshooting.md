# Docker 构建问题排查

## yarn install SSL 握手失败

### 症状

Docker 构建时 `yarn install` 阶段报错：

```
error: SSL routines:tls_get_more_records:packet length too long
error https://registry.yarnpkg.com/@esbuild/xxx.tgz: write EPROTO ...
```

### 根因

通过 HTTP 代理访问 HTTPS registry 时，代理将 HTTPS 流量当作 HTTP 处理，导致 Node.js 收到畸形数据包，SSL 握手失败。

### 解决方案

**临时方案（已应用）**：在 Dockerfile 的 `yarn install` 前设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 禁用 SSL 证书验证：

```dockerfile
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 yarn install --frozen-lockfile --ignore-engines
```

**⚠️ 安全警告**：此方案会让 Node.js 接受任何证书（包括伪造的），仅用于本地开发构建，**不要用于生产环境**。

**根本解决**：
1. 修复代理配置，让 HTTPS 流量正确透传（推荐）
2. 不走代理直连 registry.yarnpkg.com（国内可能较慢）
3. 配置 Docker 使用镜像加速器

### 相关问题

- 如果遇到 `no space left on device`，先用 `docker system df` 和 `docker buildx du --format json` 确认占用。优先清理本次任务产生、`Reclaimable: true` 的失败或旧构建缓存；核对记录 ID 后用 `docker buildx prune --filter 'id=<已确认的缓存 ID>'` 精确处理。
- 不要把 `docker system prune --volumes` 或 `docker compose down -v` 作为构建故障的默认修复：卷中可能包含账号、Pod 和数据库。构建缓存可以重建，服务数据不能当缓存删除。多个任务共用 Docker 时也不要无差别清理其他任务的镜像或缓存。过滤语义见 [Docker buildx prune 文档](https://docs.docker.com/reference/cli/docker/buildx/prune/)。
- 如果 `package.json` 或 `yarn.lock` 变更导致缓存失效，构建时间会显著增加

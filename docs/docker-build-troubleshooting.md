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

- 如果遇到 `no space left on device`，运行 `docker system prune -af --volumes` 清理磁盘空间
- 如果 `package.json` 或 `yarn.lock` 变更导致缓存失效，构建时间会显著增加

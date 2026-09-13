# Docker 构建问题排查

## 原生查询镜像与当前源码不一致

如果服务健康检查正常，但聊天数据查询报 `query options could not be mapped to the native QLever ABI`，先核对 `/opt/xpod/qlever/manifest.json` 与当前 `qlever/qlever.lock.json`。ABI 数字相同并不代表支持相同的查询选项；旧镜像可能没有 `defaultDataset` 等新语义。

服务 Dockerfile 会运行 `scripts/check-qlever-runtime-identity.cjs`，检查上游仓库、提交、补丁摘要及二进制摘要。身份不匹配时必须先按当前锁文件增量重建 QLever SDK，再构建 local runtime，最后将新 runtime 的不可变 digest 用于服务镜像。不要改写 manifest 或移除检查来继续发布。

通过打包检查后，仍须在本地完整服务上验证真实账号的数据读写与 Chat；原生镜像的构建冒烟不能替代浏览器 E2E。

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

不要通过 `NODE_TLS_REJECT_UNAUTHORIZED=0` 禁用证书验证。当前 Dockerfile 使用保留 TLS 校验的 `bun install --frozen-lockfile`。


**根本解决**：
1. 修复代理配置，让 HTTPS 流量正确透传（推荐）
2. 不走代理直连 registry.yarnpkg.com（国内可能较慢）
3. 配置 Docker 使用镜像加速器

### 相关问题

### 2026-09-09 本地证书修复验证

- 正式 Dockerfile 构建 `linux/amd64` 完整镜像成功，平台 manifest 为 `sha256:4460a5671c589ba7a8f63ac8eb95131007f17c71c76e9db8a9f65969a4f6ba90`。
- 系统依赖、1910 个 Bun 依赖、TypeScript、Components.js、workspace 包及四个 Web 目标均构建通过，TLS 校验保持开启。
- 打包回归测试 12/12 通过。最终镜像无宿主源码挂载时，CLI help 退出码 0，Debian HTTPS 请求返回 200，QLever 动态库无缺失。
- 这些证据仅覆盖构建和镜像冒烟，不代表完整集成测试、广州部署或 Chat E2E 已通过。

- 原生 QLever runtime 可能没有 `/etc/ssl` 和默认 CA 链接。仅复制 CA bundle 不足以让 APT 找到证书。Dockerfile 从 Node runtime 引导 CA bundle，使用 `Acquire::https::CaInfo` 显式指定路径完成 HTTPS 下载，再安装 `ca-certificates` 恢复发行版管理的信任目录。禁止关闭 `Verify-Peer` 或 `Verify-Host`；此问题不能仅凭 Fake-IP 地址判定为 VPN 失效。

- 如果遇到 `no space left on device`，先用 `docker system df` 和 `docker buildx du --format json` 确认占用。优先清理本次任务产生、`Reclaimable: true` 的失败或旧构建缓存；核对记录 ID 后用 `docker buildx prune --filter 'id=<已确认的缓存 ID>'` 精确处理。
- 不要把 `docker system prune --volumes` 或 `docker compose down -v` 作为构建故障的默认修复：卷中可能包含账号、Pod 和数据库。构建缓存可以重建，服务数据不能当缓存删除。多个任务共用 Docker 时也不要无差别清理其他任务的镜像或缓存。过滤语义见 [Docker buildx prune 文档](https://docs.docker.com/reference/cli/docker/buildx/prune/)。
- 如果 `package.json` 或 `yarn.lock` 变更导致缓存失效，构建时间会显著增加

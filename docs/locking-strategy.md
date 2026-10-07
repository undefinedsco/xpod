# CSS 锁机制梳理

## 1. CSS 锁的层次结构

CSS 的锁系统分为三层：

### 1.1 底层锁 (ResourceLocker 接口)
只提供 `acquire()` / `release()` 基础操作：

| 类名 | 说明 | 线程安全 | 多进程安全 |
|------|------|----------|------------|
| `MemoryResourceLocker` | 内存锁 | ✅ | ❌ |
| `FileSystemResourceLocker` | 文件锁 (proper-lockfile) | ✅ | ✅ |
| `RedisLocker` | Redis 分布式锁 | ✅ | ✅ |
| `VoidLocker` | 空锁（不加锁） | - | - |

### 1.2 中间层 (ReadWriteLocker 适配)
将 `ResourceLocker` 转换为支持读写锁的 `ReadWriteLocker`：

| 类名 | 说明 | 用途 |
|------|------|------|
| `GreedyReadWriteLocker` | 使用 KeyValueStorage 存储读计数，支持多读单写 | 内存锁方案 |
| `PartialReadWriteLocker` | 内存中存储读计数，同 Worker 内可多读 | 文件锁方案 |

**注意**：`RedisLocker` 直接实现了 `ReadWriteLocker`，不需要这层适配。

### 1.3 顶层 (过期包装)
| 类名 | 说明 |
|------|------|
| `WrappedExpiringReadWriteLocker` | 添加锁过期机制，提供 `maintainLock` 回调 |

## 2. CSS 官方配置方案

### 2.1 内存锁 (`memory.json`)
```
WrappedExpiringReadWriteLocker (expiration: 6000ms)
  └── GreedyReadWriteLocker
        └── MemoryResourceLocker
        └── KeyValueStorage (存储读计数)
```
- ✅ 单进程并发安全
- ❌ 多进程/多 Worker 不安全
- ✅ 不会死锁/崩溃

### 2.2 文件锁 (`file.json`)
```
WrappedExpiringReadWriteLocker (expiration: 6000ms)
  └── PartialReadWriteLocker
        └── FileSystemResourceLocker
```
- ✅ 单进程并发安全
- ⚠️ 多进程部分安全（同 Worker 内可多读，跨 Worker 需等待）
- ❌ 高并发时可能崩溃（proper-lockfile 问题）

### 2.3 Redis 锁 (`redis.json`)
```
WrappedExpiringReadWriteLocker (expiration: 6000ms)
  └── RedisLocker
```
- ✅ 单进程并发安全
- ✅ 多进程/多 Worker 安全
- ✅ 分布式部署安全
- 需要 Redis 依赖

### 2.4 空锁 (`debug-void.json`)
```
VoidLocker
```
- ⚠️ 仅用于开发调试，生产环境禁用

## 3. XPod 配置

| 配置入口 | 锁配置 | 适用场景 |
|----------|--------|----------|
| `config/local.json` | CSS 官方内存锁方案，过期时间 6000ms | 本地开发/桌面 |
| `config/cloud.json` | Redis 锁，过期时间 6000ms | 生产环境（单机/集群）；远程 I/O 不允许发生在 Account create-pod 的 CSS 资源锁内 |
| `config/xpod.json` | CSS 官方内存锁方案，过期时间 6000ms | 单体 Xpod 配置 |

### Managed Local provisioning 的锁边界与 profile 归属（2026-10-03 纠正，发布验收中）

`profile/card` 是 Cloud 托管的独立身份与 Pod 发现文档。无论用户数据存储在 Cloud 还是 Local，managed 部署中的 card 都在 Cloud；card 声明 Cloud issuer 与实际 Pod 的 canonical storage URL。Local 保存 Pod 数据和其访问控制，不铸造另一份权威 WebID/profile。Cloud 托管 card 不等于创建 Cloud 用户存储 Pod。

正确的流程必须同时满足身份归属和锁边界：

1. Cloud Account 控制面先分配或验证属于当前 Account 的 Cloud WebID，并准备独立 card 及其原生访问控制。Cloud 身份的归属必须由 Account 权威确认，不能因 Local 签了 receipt 就自动关联任意 WebID。
2. 调用方在 Account create-pod 的锁外准备 Local Pod，传入已确认的 Cloud WebID。`spUrl` 仅负责回调和路由；Local 根据已分配的 `spDomain` 确定 canonical Pod URL。没有公网数据入站入口时仍可通过本机可用路径准备，不改变 Cloud card 或 WebID。
3. Local 返回绑定 Pod 名、Cloud WebID、canonical Pod URL 和 Pod generation 的短期 `provisionReceipt`。回执使用长期 service token 的 SHA-256 值签发，浏览器仅持有的短期 `serviceAccessToken` 不能伪造。
4. Cloud finalize 验证当前 Account 的 WebID 关联及 receipt 的 SP/Pod/身份绑定，登记远程 Pod 元数据并更新 Cloud card 的 `solid:storage`。所有跨服务网络访问继续放在 CSS Account 资源锁外，锁内不得读取 Local profile，也不得重新创建一个 Cloud 存储 Pod。

`CloudProfileCreator` 提供原生 Account profile 准备与 storage 登记；`LocalPodProvisioningService` 在 managed 模式要求已确定的 Cloud WebID，不创建 Local card。Cloud card 准备与标准 Cloud Pod 创建共用命名空间锁；新资源使用 If-None-Match:*，只有已成功创建的资源进入失败清理。HTTP owner 修改与 storage 增量绑定的并发回归单独验收。原无公网夹具使用错误 Local-profile 拓扑，不能作为新契约证据；修正后的真实栈验收与发布结果另行记录。既有 node-origin WebID 的迁移单独处理，不自动改写已持有身份。

## 4. 部署场景选择

| 场景 | 推荐锁方案 | 说明 |
|------|-----------|------|
| 本地开发 | 内存锁 | 简单可靠，无依赖 |
| 单机单进程 | 内存锁 | 足够，无需额外复杂度 |
| 单机多 Worker | Redis 锁 / SQLite | 需要跨进程同步 |
| 分布式集群 | Redis 锁 | 必须使用分布式锁 |

## 5. SQLite 锁（QuintStore 场景）

如果使用 QuintStore（SQLite）存储数据：
- SQLite 的 WAL 模式支持多进程并发
- 数据操作本身有事务保护
- 可以减少对额外锁机制的依赖

但 CSS 的锁机制主要是保护文件系统操作，如果仍有非 RDF 文件存储，仍需要锁。

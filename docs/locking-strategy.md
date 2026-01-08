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

| 配置文件 | 锁配置 | 适用场景 |
|----------|--------|----------|
| `extensions.local.json` | CSS 官方内存锁方案 | 本地开发 |
| `extensions.dev.json` | CSS 官方内存锁方案 | 开发环境 |
| `extensions.cloud.json` | Redis 锁 | 生产环境（单机/集群） |
| `extensions.server.router.json` | Redis 锁 | 生产环境（带路由） |

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

# Agent 文件系统性能比较

记录日期：2026-09-30（Asia/Shanghai）。关联：[候选调研](agent-filesystem-research.md)。本页保留测量条件；后续真实挂载与公开包状态见 [预览发行记录](xpod-cli-preview-release.md)，挂载验收通过不构成新的性能结论。

结论：直接数据库 API、小文件系统挂载和远端按需读取必须分别比较。本机基线支持“直接 SQLite 对小 BLOB 和批量枚举有优势，原生 FS 的属性查询有优势”；没有测出 AgentFS 的挂载性能，也没有证据支持统一的“原生性能 99%”。

## 本机直接 API 基线

环境：Apple M1 Pro / arm64、macOS 26.3、APFS SSD、Bun 1.3.8、Bun 内置 SQLite 3.51.0。复用现有工具，没有安装候选、创建 OS 挂载或连接实际 Xpod。

运行方式：

```sh
bun scripts/benchmark-directory-storage.ts
```

[可复现脚本](../scripts/benchmark-directory-storage.ts)、[两次完整原始记录](benchmarks/directory-storage-baseline-2026-09-30.json)。临时数据在 `.test-data/directory-storage-baseline/run-*`，脚本 finally 清理本次创建的 DB 和文件。

条件：

- 单进程、单并发；分别生成 2,000 个 1KiB、10KiB、128KiB 文件，共 6,000 个文件。
- 每种大小共用一份随机 payload，双方字节相同，无应用压缩；读取随机顺序固定。SQLite 单行存整个文件 BLOB，不使用 AgentFS inode/chunk schema。
- 比较 Bun `node:fs` 同步 API 与 `bun:sqlite` 预编译语句；SQLite 连接复用，双方包含各自运行时的 Buffer/对象构造成本。
- 每项预热一次、测量七轮，每轮轮换先测哪个 backend；没有清除 OS 缓存，没有隔离机器上的其他活动，不是冷盘或裸 syscall 基准。
- 执行两个独立进程，各自重新生成/清理 fixture；下表范围是两次运行各自“七轮批次耗时中位数”的最小/最大值，不是单次操作 p50/p95。
- 读取前抽样逐字节核对，写入后检查全部 200 项。写入每轮改变字节，避免重复写相同内容导致未写脏页。

| 工作负载 | 原生 FS，整批 ms | 直接 SQLite，整批 ms | 本机观察 |
| --- | ---: | ---: | --- |
| 随机读 2,000 个 1KiB 文件 | 47.20–48.31 | 12.57–12.58 | SQLite 约 3.75–3.84 倍吞吐 |
| 随机读 2,000 个 10KiB 文件 | 55.43–55.64 | 23.79–24.18 | SQLite 约 2.30–2.33 倍吞吐 |
| 随机读 2,000 个 128KiB 文件 | 86.53–280.52 | 95.09–95.93 | FS 波动显著，两次胜负改变，不得给出稳定倍率 |
| 2,000 次文件大小查询 | 5.84–5.94 | 15.44–16.49 | FS stat 约 2.60–2.82 倍吞吐；DB 只查 size，不是完整 POSIX getattr |
| 列出 2,000 个文件名，重复 100 次 | 112.73–113.74 | 25.27–25.69 | SQL 批量枚举约 4.39–4.50 倍吞吐 |

这组数据不能外推到 AgentFS/Turso：它没有 Linux FUSE、macOS NFS、URI/inode 映射、overlay、索引、认证或网络；也没有测百万文件、多写者、编辑器、Git/构建与 Agent 会话。

## 写入与持久化口径

下面都是覆盖 200 个现有 10KiB 文件，报告整批耗时；不包括 SQLite WAL checkpoint。

| 操作与设置 | 两次运行中位数范围，ms |
| --- | ---: |
| FS writeFileSync，无显式 fsync | 7.89–7.91 |
| SQLite WAL/NORMAL，逐文件事务 | 2.98–5.43 |
| SQLite WAL/NORMAL，200 文件一个事务 | 1.38–1.87 |
| FS 每文件写入后 fsync | 33.06–35.06 |
| SQLite WAL/FULL，逐文件事务 | 12.89–14.52 |
| SQLite WAL/FULL，200 文件一个事务 | 1.99–2.18 |

不能把这张表压成“DB 写入快多少”：批量事务改变提交次数和原子性；FS 无 fsync 与 SQLite NORMAL 都不提供与逐次持久化相同的保障；FULL 事务与单文件 fsync 的内部写入布局不同。macOS 的 fsync 也不是 F_FULLFSYNC；没有断电、崩溃、重启恢复测试。checkpoint 被排除，不能据此计算长期持续写吞吐。NORMAL 写入两次波动明显。

## 官方挂载层证据

### Redis AFS：有本地目录对照数字

[官方 README](https://github.com/redis/agent-filesystem#why-redis) 给出 macOS NFS、33 文件语料、7 轮中位数。项目未在本轮安装，数字为厂商自测；不能外推 WAN 冷读取、Xpod 认证或任意文件规模。

| 操作 | 本地 ms | AFS ms | 相对时间 |
| --- | ---: | ---: | ---: |
| 读取 medium source file | 0.01 | 0.01 | 显示精度下相同，不能推导 99% |
| literal grep 整个语料 | 0.95 | 1.26 | 1.33 倍 |
| ignore-case grep | 1.69 | 3.07 | 1.82 倍 |
| walk tree | 0.15 | 0.11 | 0.73 倍，小样本不能推广 |
| 覆盖 2KB 文件 | 0.07 | 0.91 | 13 倍 |
| mkdir + rmdir | 0.06 | 2.34 | 39 倍 |

相对倍率很大时，绝对耗时仍可能只有几毫秒；是否影响 Agent，应测一整次工具操作的文件数量、同步次数与耗时。

### AgentFS：有对照脚本，缺可比较结果

[官方 FUSE 介绍](https://turso.tech/blog/agentfs-fuse) 说明内核 page cache/writeback 可降低开销，非缓存读取与 fsync 有额外成本；文中接近原生的表述不是完整对照基准。

源码核对固定于 commit `0a014ebd4918615baff589ed17486e557e7c6a23`，不默认等同某个发布版：

- [syscall 对照脚本](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/perf/syscall/run.sh) 比较 native/base/delta 的 open+close/statx；默认单文件 100,000 次、1,000 次预热。是 Linux 微基准，不代表 macOS NFS、冷目录遍历或持久化写回。
- [npm 模拟工作负载](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/perf/simulate-npm-workload.sh) 有目录/小文件混合操作，但本轮未运行，未找到可用于 Xpod 比较的完整原生对照结果。
- [存储实现](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/sdk/rust/src/filesystem/agentfs.rs) 普通写入采用 synchronous OFF，fsync 临时设置 FULL 后 BEGIN/COMMIT；这只是源码策略，没有验证掉电持久性。不能把普通 write 返回与已可靠保存混为一谈。

libsqlfs 的 [c_perf 测试](https://github.com/guardianproject/libsqlfs/blob/4d330a605516ec1e72ece4c44b3a17e8bb7b4e7f/tests/c_perf.c) 经库 API 访问，不是原生 FS 与 FUSE 的对照；本轮没有运行。

### JuiceFS：metadata backend 和内容存储都有影响

[官方 metadata engine 对照](https://juicefs.com/docs/community/metadata_engines_benchmark/) 使用 2023 年 JuiceFS 1.1.0-beta1、EC2、相同 S3 内容后端。PostgreSQL/Redis-Always 的 stat 吞吐分别约 7,846 / 12,314 files/s，大文件读取分别约 896 / 924 MiB/s。纯 metadata 的 readdir_1k 延迟 PostgreSQL/Redis-Always 为 18,414 / 1,490 微秒；这些是特定 backend/部署的比较，不能解读为相对 APFS 性能。

[官方评估指南](https://juicefs.com/docs/community/performance_evaluation_guide/) 的较早 S3 环境说明：小文件持久化常受单次对象请求的 10–30ms 固定成本影响；内存缓冲 write 返回很快，而 close/flush 要承担上传成本。当前 Xpod、其他网络和存储后端须重新测试。

### SQLite 的“快 35%”说明了什么

[官方测试](https://www.sqlite.org/fasterthanfs.html) 实测于 2017 年，主要是平均约 10KB 的小 BLOB、预热缓存和直接 SQLite API；复用 DB 句柄可减少逐文件 open/close。文章也说明冷缓存或不同硬件可能相反。它支持小 BLOB 的存储选择，不能直接证明 DB-as-FS 挂载速度。

## 对 Xpod 的判断与下一次验证

- Local 的现有文件继续直接访问，避免额外目录层；DB 负责目录索引/FTS/VEC 或数据投影，不因小 BLOB API 测试就迁移全部正文。
- Cloud 优先降低 metadata 的串行远端往返，利用批量目录查询、缓存和按需正文读取；DB 客户端应位于可信服务边界，授权接口不等同于直接向 Agent 开放数据库。
- 缓存读取、本地 delta 写入、远端写回成功和可靠持久化分别计时。FTS/VEC 检索与原生全目录 grep 有不同语义，分开报告。
- 下一次原型需在同一数据集对比真实目录与挂载目录，分别覆盖 Linux FUSE / macOS NFS、冷/热 cache、真实 Gateway 认证/权限、远端修改失效、小文件批量、原子保存、fsync、断网恢复及实际 Agent 工具流程。
- 本轮只有直接 API 基线及文档/源码证据，不声称候选挂载、Pod 兼容性或真实 Xpod 集成验收通过。

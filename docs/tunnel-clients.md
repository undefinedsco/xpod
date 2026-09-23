# 隧道客户端：插件式安装（不随产物分发）

Xpod 的发布产物（Docker 镜像、npm 包、桌面包）**不内置** `cloudflared`/`ngrok`/`frpc`。
隧道客户端按插件处理：产物保持干净，操作者按需安装，运行时按固定顺序解析。

## 为什么不分发

| 客户端 | 许可 | 能否随我们的产物分发 |
| --- | --- | --- |
| `cloudflared` | Apache-2.0 | 可以（但会让镜像增大约 40MB，且需要版本/签名策略） |
| `frpc`（上游） | Apache-2.0 | 可以（同上） |
| `ngrok` agent | 专有（ngrok ToS） | **不可**，需其许可 |
| `frpc`（natfrp fork） | 无公开源码 | **不可**，需其许可 |

许可事实写在 provider 目录里（`src/tunnel/TunnelProviderCatalog.ts` 的 `client.redistributable` /
`client.license`），`bun scripts/check-tunnel-clients.ts` 会把它打印出来。

## 安装方式（三选一，运行时按顺序尝试）

1. **显式路径**（最高优先级）：`CLOUDFLARED_BIN` / `NGROK_BIN` / `FRPC_BIN`，或 provider 选项。
   配了路径但文件不可执行时，运行时会直接报错，不会静默改用别的二进制。
2. **插件目录**：`<包根>/vendor/tunnel-clients/<binary>`（可执行位 0755）。这是"把 cloudflared
   当插件"的落点：把下载好的二进制放进去即可，不需要改配置。
3. **PATH**：交给系统包管理器（`brew install cloudflared`、`apt install cloudflared`，
   Sakura FRP 用 natfrp 官方客户端——它的 `frpc` 才接受 `-f <token>`）。

## 预检

```sh
bun scripts/check-tunnel-clients.ts                      # 逐个 provider 打印来源与命中路径
bun scripts/check-tunnel-clients.ts --require cloudflare # 缺客户端时退出码 1（可用于验收前置）
bun scripts/check-tunnel-clients.ts --json
```

缺失时运行时报告的仍是 `binary-missing:<provider>:<binary>`，后面附上该客户端的安装提示：
这个前缀是机器可读的，验收脚本依赖它。

## 明确不做

不提供自动下载器：下载并落地一个第三方二进制需要同时确定版本锁定、校验和来源与签名校验
策略，这些是产品/供应链决策；在此之前，插件目录 + 包管理器 + 预检已经让"缺客户端"这件事
在启动前就能被发现，并且报错里带着该怎么装。

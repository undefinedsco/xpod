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

## 设置页上的按钮

隧道配置旁边的 **Tunnel clients** 卡片提供两件事：

- **Check clients**：逐 provider 报告 Ready/Missing、来源（显式路径 / 插件目录 / **PATH 命中
  的真实绝对路径**）、版本（`--version` 输出）与安装提示。判定口径与
  `bun scripts/check-tunnel-clients.ts` 完全一致——两处都走同一个解析器，不再各有一套
  "算不算在 PATH 上"的意见。
- **Download**：只对存在稳定平台直链的客户端开放（目前是 cloudflared：linux 直出二进制、
  macOS 走 `.tgz` 解包）。下载到插件目录、`chmod 0755`，并且**必须能跑起来**才留下；跑不起来
  就删掉并报错。没有可钉直链的客户端（ngrok agent、natfrp 的 frpc fork）只显示安装提示，
  不猜 URL。

**仍未做**：下载不校验发布方签名（只验证"能执行且 `--version` 有输出"）。要做校验和/签名
校验，需要先确定每个客户端的校验和来源与轮换策略，属供应链决策。

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

## Sakura FRP / natfrp 的 frpc 从哪来（以及验收为什么用过 Docker）

上游 `frpc`（fatedier/frp）**不能**用于 Sakura：它不认厂商的 `frpc -f <访问密钥>:<隧道ID>`
语法，官方文档明确要求版本号里带 `sakura`（≥ `0.51.0-sakura-14`），否则失去官方支持。
natfrp 客户端的获取渠道只有两个：

1. **管理面板「软件下载」**：按系统与架构给出直链（Linux/macOS/Windows、amd64/arm64/…）。
   链接来自登录后的面板，**没有可钉进仓库的公共直链**，所以设置页按"没有稳定直链"处理，
   只显示安装提示（见上一节）。拿到后放进 PATH 或 `vendor/tunnel-clients/frpc` 即可。
2. **官方镜像 `natfrp.com/frpc`**（亦有 `natfrp/frpc`、`ghcr.io/natfrp/frpc`）：可与
   `docker pull` 一起被钉住，是**唯一可复现拉取**的渠道，因此验收 harness 在"这台机器没有
   原生客户端"时用它。

**为什么在 macOS 上不能"从镜像里抠出二进制直接用"**：镜像是 **Linux** 二进制。实测
`docker create` + `docker cp` 取出 `/frpc` 后 `file` 报
`ELF 64-bit LSB executable, ARM aarch64`，在 darwin 上执行得到 `cannot execute binary file`
（`--version` 都跑不起来）。所以 Docker 不是产品需要，而是**这台机器的客户端处境**：要么用
面板给的 macOS 构建（原生跑，无需 Docker），要么让 Docker 提供一个 Linux 运行时。

验收 harness 的解析顺序已与产品**完全一致**（`--frpc-bin`/`FRPC_BIN` → `vendor/tunnel-clients/`
→ PATH → 官方镜像兜底），并在证据里记 `source`（`configured|bundled|path|image|absent`）与
版本号；原生客户端存在时**不再碰 Docker**。只有走镜像时才需要 loopback relay 命名空间
（容器到不了宿主的 `127.0.0.1`），原生客户端直接连本机回环，relay 不参与。

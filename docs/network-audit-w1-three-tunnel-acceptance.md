# 三家隧道统一真实验收 —— 分项证据与未覆盖边界

- 目标：联网审查报告 W1 收尾项「ngrok / cloudflared / Sakura 三家做一次统一真实验收」
- 代码：`release/0.4.11` @ `e239ee10`+（`codex/network-audit-w1` 同点）
- **全绿运行（2026-09-20 深夜）：`.test-data/acceptance/w1-final/evidence.json`，64 项检查 / 0 项失败** —— ngrok、cloudflared quick tunnel、**cloudflared 具名隧道**（`https://node-0000.undefineds.co/`，Dashboard Service `http://localhost:5737`）、SakuraFrp（`https://frp-dad.com:35246/`，官方客户端 + relay 命名空间 + 自签证书如实记录）四条真实入口腿全部 `serving`，四条都有入口归属校验（入口回打的运行时 PID = 本候选实例），管理面隔离矩阵全部通过
- **最新统一运行：`.test-data/acceptance/w1-round19/evidence.json`（58 项检查 / 2 项失败）—— 三家里的三家都在同一次运行里拿到真实入口**：ngrok、cloudflared quick tunnel、SakuraFrp（后者用 vendor 客户端 config 模式把平台生成的配置指到隔离候选的端口，因为控制台的 5737 被操作者实例占用；证据里记录了这次端口调整与自签证书）。两项失败都是同一个控制台事实：`node-0000.undefineds.co` 尚未挂到隧道 `6ee69e25-…` 的 public hostname 上（530/1033）。
- 端口语义（2026-09-20 修订）：Sakura 不再需要操作者填端口 —— runtime 用同一凭据读 `GET /v4/tunnels` 的 `local_port` 并把 ingress 钉在该端口（`resolveIngressPort()`，提交 `d2fcfb4a`）；显式 `XPOD_GATEWAY_INGRESS_PORT` 仍优先但**严格**（被占用即报错，不再静默换端口）。cloudflared **具名**隧道的回源端口在 Dashboard 里，provider 现在会读回远端配置并报 `origin-mismatch:dashboard=<p>,runtime=<q>`（提交 `9d0576a0`），不再让这种不匹配表现为"入口不可达"。
- 运行方式：`bun run accept:network-tunnel --start --candidate-port 3300 --env-file <keyfile>`；跑的是**隔离候选实例**，不触碰操作者的实例。隧道腿一律打到该候选的 **Gateway 端口**（`--candidate-port`），与产品口径一致

## 1. 逐家结论

### ngrok —— **通过（真实公网入口）**

| 检查 | 观测 | 证据 |
| --- | --- | --- |
| 真实入口就绪 | `active · https://ravioli-basics-throbbing.ngrok-free.dev/` | `w1-round13b/evidence.json#ngrok-real-entry` |
| 入口归属 | 入口 `/service/status` 的运行时 PID 与候选实例一致（`pids 18327,18328`） | `#entry-serves-this-candidate` |
| 管理面隔离 | 匿名 `GET /api/admin/status` **403**；伪造 `x-xpod-admin-proxy-loopback`+`x-forwarded-*` **403**；匿名 `PUT /api/admin/config` **403**；显式 token **200**；普通路由 **200** | `#public/admin-*`、`#public/ordinary-route` |
| 凭据来源 | `NGROK_AUTHTOKEN`（env file，指纹 `sha256:43c2d38f`）；入口由 provider 自行发现，操作者不填 URL | 同上 |
| 失败腿 | 无效凭据 / 伪造 hostname → 从不变 active 且给出 ngrok 原始原因（Free 套餐 `ERR_NGROK_314`）；缺二进制 → `binary-missing:ngrok:<path>` | `#wrong-credential-never-active`、`#missing-binary-named` |

网络说明：本轮之前 `api.ngrok.com` 与 `connect/us/eu/ap/…ngrok-agent.com` 在本机 TLS 全部被重置（TCP 可连、https `000`，agent 报 `connection reset`），属环境条件；网络恢复后同一条腿通过。对照证据：`.test-data/acceptance/w1-round4-final/evidence.json`（当日早先网络正常时的通过记录）。

### cloudflared —— **通过（真实公网入口，quick tunnel）；具名隧道待有效 token**

| 检查 | 观测 | 证据 |
| --- | --- | --- |
| quick tunnel 真实入口 | `https://turns-paul-offer-hook.trycloudflare.com · serving`（无需账号） | `w1-round13b#cloudflared-quick-tunnel` |
| 入口归属 | `pids 17887,17888` 与候选一致 | `w1-round13b#entry-serves-this-candidate` |
| 管理面隔离 | 同上五项全过（403/403/403/200/200） | `w1-round13b#public/*` |
| 就绪语义 | 只有注册连接后才算就绪；无效 token → `error · cloudflared exited with code 255` | `#cloudflare-invalid-token` |
| 具名隧道 | **阻塞**：旧 token 被 Cloudflare 拒绝（`Unauthorized: Tunnel not found`，两个旧 token 均如此）；新 token（指纹 `sha256:7a172507`，隧道 UUID `6ee69e25-0c46-48a3-9ed3-ebd4bd0048e4`）可以注册（4 条连接），但 `node-0000.undefineds.co` 仍返回 530/1033，且 connector 全程未收到远端配置（无 `Updated to new configuration`）→ 该 hostname 尚未挂到这条隧道上；声明入口不可达单列 `#public-entry-declared-unreachable`，不冒充隔离结论 | `w1-round17b`、`w1-round15/16/17/18` 的 connector 探测 |

解锁动作：Zero Trust → Networks → Tunnels → `linx-local` 复制**新** token 填入 `CLOUDFLARE_TUNNEL_TOKEN`；并把该隧道 public hostname（`node-0000.undefineds.co`）的 **Service（回源）** 指向运行时对外唯一入口 **Gateway 端口**（本地默认 5737；网络设置页显示的就是它）。验收脚本现在把隧道腿直接打到候选的 Gateway 端口，不再需要 `--ingress-port`；控制台填了别的端口时，runtime 会报 `origin-mismatch`，脚本按候选 Gateway 端口给出结论。DNS 记录建议由 DNS only 改为 **Proxied**（Cloudflare 对 Tunnel 记录的告警即此）。

### SakuraFrp —— **阻塞（两个明确原因，均非本仓库缺陷）**

| 事实 | 观测 | 证据 |
| --- | --- | --- |
| 隧道存在 | id `29212252` `xpod`，TCP，node 35 长沙三线PLUS6，本地 `127.0.0.1:5737`，远程 `35246`，入口 `frp-dad.com:35246` | `GET /v4/tunnels` |
| **上游 frpc 兼容（数据面）** | 平台 `POST /v4/tunnel/config` 为上游 `0.71.0` 生成 11 键 TOML；原生 arm64 上游 frpc 日志 `login to server success` → `proxy added: [xpod]` → `start proxy success`，平台同步 `online: true` | `.test-data/acceptance/sakura-client-probe/1789916577057/`（`frpc.toml` + `upstream-frpc.log`） |
| **上游 frpc 无法承担 auto-HTTPS（已实测）** | 打开自动 HTTPS 后重跑探针：平台为上游 `0.71.0` 生成的配置**逐键不变**（11 键，无 TLS/auto-HTTPS 入口项），`https://frp-dad.com:35246/` 经上游客户端**不可达**；明文 HTTP 仍被策略拒绝。→ 该功能是 natfrp **fork 客户端侧**特性（官方文档："要求 frpc 采用 TLS 接受对外连接，对壳脱掉后再用明文协议连接本地服务"），上游客户端表达不了 | `.test-data/acceptance/sakura-client-probe/1789918642161/`，`GET /v4/tunnels` → `extra: auto_https = auto` |
| **明文 HTTP 被平台策略拒绝** | `http://frp-dad.com:35246/` → `501 Not Implemented`，`Server: SakuraFrp`，正文要求开启 **自动 HTTPS**（机房合规）；官方文档速查表「网页（国内节点）✔️必须」；直接 HTTPS 该端口不成立（TLS alert），该功能为客户端侧终止 TLS 后明文回源 | 同上 + `docs` 引用 |
| 产品侧诚实化 | 未开自动 HTTPS 时不再声称 `http://…` 入口，改报 `sakura-auto-https-required: enable 自动 HTTPS …`；开了才报 `https://host:port/` | `SakuraFrpTunnelProvider.test.ts`（含负向回归）、提交 `2b3836d7` |
| 数据面客户端 | 官方客户端不在 PATH 且本机无原生二进制；natfrp 官方镜像在 macOS 上**无法访问宿主 loopback**（实测 `--network=host` 亦然），而隧道 `local_ip=127.0.0.1` → 容器客户端不可用 | `w1-round13b#sakura-real-tunnel` detail |
| 就绪/接管/缺二进制 | 三条语义均通过（`proxy-ready` 才 connected、外来 frpc → `frpc-already-running`、缺二进制 → `binary-missing:sakura-frp:`） | `#sakura-refuses-foreign-frpc`、`#sakura-missing-binary` |

**第 16 轮补充（真实入口已打到操作者的活实例）**：用官方客户端（natfrp 镜像 + relay 命名空间，绕过"容器打不到宿主 loopback"）连上隧道后，`https://frp-dad.com:35246/...` 的请求**确实到达了操作者的 `:3000` 实例**，但被 CSS 以 500 拒绝：`The identifier https://frp-dad.com:35246/api/admin/status is outside the configured identifier space.` —— 即公网 Host 没被 W0 的入站隔离/Host 处理接住，直接被 CSS 判为标识空间之外。结论：**操作者 `:3000` 上跑的是主 checkout（`release/0.4.5` + 未提交改动），不是修复版**，因此不能用于 W0/W1 验收；W0/W1 的验收需要 `release/0.4.11` 起的实例。另：该实例的 CSS 子进程占用 **5737**（正是 Sakura 隧道的本地端口），隔离候选绑不上 5737 → 要么改隧道本地端口，要么把活实例切到 `release/0.4.11` 后做只读复用验收（harness 已支持复用模式不写配置）。

**自动 HTTPS 已由操作者开启**（`extra: auto_https = auto`），但解锁真实数据面只差客户端本体：

1. **推荐（产品真实用法）**：操作者从面板「软件下载 → frpc → macOS arm64」下载**原生官方 frpc**，`chmod 755` 后用 `FRPC_BIN=<路径>` 指向它（或直接放进 PATH）。本机此前没有该二进制，容器路线又打不到宿主 loopback，所以这一步无法由本仓库代办。
2. 备选：把隧道 `local_ip` 改成 `host.docker.internal`，让我用 natfrp 官方镜像在容器里跑（能验通，但不是真实产品形态，需操作者同意改动其隧道配置）。
3. **已排除**：单独内置上游 frpc 无法覆盖"Sakura + 国内节点 + 网页入口"这一组合（auto-HTTPS 表达不了）；上游客户端仍适用于非 Web 协议/国外节点等不需要 auto-HTTPS 的场景。

## 2. 三家之外的统一项（同一次运行，全部通过）

- A04：真实账号 + 会话 + Pod 写入/读回 + 匿名读被拒（401）。
- A01：设置 API 保存 profile → 契约回读（canonical `publicUrl`）→ 落盘 → 重启 → provider 达 `proxy-ready` → **显式关闭后重启仍关闭**。
- ingress（不可信入站监听）：匿名 403、伪造证据 403、匿名变更 403、显式 token 200、普通路由 200。
- 作用域与默认：无 relay/Tailscale 供应商；P2P 默认关闭。

## 2.1 发布状态（2026-09-21）

- **0.4.13 已在 `c202b690` 发布**（`v0.4.13` tag，Release 流水线全绿：npm staging → 4 组 consumer 验证 → `latest` → GHCR digest 提升 → 生产 `.co` 部署），**不含**本次 W0/W1 的工作。
- W0/W1 已合入 **`release/0.4.14`**：合并提交 `bb5bbd30`（冲突 5 个源文件 + 哈希资源重建），其 RC（run `35555651162`）**全绿**，含 `build_image`、`deploy_and_accept`、`Finalize RC acceptance`，产出 `release-acceptance-bb5bbd30…` artifact。
- 版本提交 **`a5c98e19`**（`package.json`/`desktop/package.json`/`bun.lock` → 0.4.14），该 commit 上 `build:ts`、`build:components`、完整集成测试 exit 0；已推送，RC run `35560196840`。
- **发布已完成（2026-09-21 05:00–05:24Z）**：`v0.4.14` tag（注释 tag，指向 `a5c98e19`）→ Release 流水线 run `35562955339` **全绿**：
  - `Validate accepted release candidate` 通过（promotion guard 认下 RC 的 `release-acceptance-a5c98e19…` artifact 与 accepted digest）；
  - npm：`latest` 与 `stable-staging` 均为 **0.4.14**（tarball 已发布），4 组 consumer 矩阵（node/bun × 22/24/25）通过后才提升 `latest`；
  - GHCR：accepted digest `sha256:9554a3a6…` 被重打成 **`ghcr.io/undefinedsco/xpod:0.4.14` / `:latest`**（不重新构建）；
  - 生产 `.co`：部署的正是该 digest（job 内校验 deployment image 与 ready pod imageID 一致），`PUBLIC_BASE_URL=https://id.undefineds.co`；
  - GitHub Release `v0.4.14` 已创建（含 macOS 桌面产物）；独立冒烟：`id.undefineds.co/.well-known/openid-configuration` 200、`pods.undefineds.co` 200。
- **合入主干已完成并已把发布线并回主干**：`origin/main = cd2349f3`（2026-09-21 16:4x 推送），链路为 `cd2349f3`（把测试预算硬化 `41243663` 并入主干）→ `ab136eeb`（把 `release/0.4.14` 并入主干，版本号与发布对齐）→ `675cc22d`（文档提交）→ `bb5bbd30`（W1 合并）→ `d0e1c76e`（W0）。合并前在主干树上跑过 `bun install --frozen-lockfile`、`build:packages`、`build:ts`（exit 0）与 `tests/tunnel`（52 条通过）。更早一版的核对：`origin/main = 675cc22d` ⊃ 合并提交 `bb5bbd30` ⊃ W0 的 `d0e1c76e`；合并后主干 CI 的 `Test Files 605 passed | 37 skipped`（无测试文件失败；job 标红是既有的 `Error: unreachable` 未处理错误噪声，合并前同样存在）。

## 2.2 后续验收的当前状态（2026-09-21）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| A04 AI 四层 | **已通过** | `.test-data/acceptance/live-gateway-login-chat-standalone.json`：runtime / identity / podReadWrite / gatewayAuth / aiConnections / models / chat 全部 ok；Chat 是真响应（HTTP 200，contentChars=7），凭据用后即撤销。跑在 `release/0.4.14` 隔离候选（standalone，自 IdP）上，未触碰操作者 `:3000`，也不需要 Cloud 引导码 |
| Cloud-managed canonical Pod 读取 | 待做（活实例只读） | 操作者活实例已 provision 且心跳正常；该通道不在 W1 改动面，验证为"通道可用" |
| **本地 DNS 供应商（A07 / N14 / N02）** | **TODO（操作者要求先挂起）** | 需要**专用测试 zone** 的 scoped token（`CLOUDFLARE_API_TOKEN` + `XPOD_DNS_DOMAIN`）才能验 `CloudflareDnsProvider`/`TencentDnsProvider` 的记录增删、MX/TXT 保留与 `_acme-challenge` 写入；发布后冒烟覆盖不到这条本地代码路径 |
| A09 双 Cloud 并发 | 待做（Docker 即可） | 仓库自带 `docker-compose.cluster.yml`，含 `cloud`(6300) 与 **`cloud_b`(6400/6401)** 两个 Cloud 节点；在本机 Docker 里即可验"两 Cloud 互不串台、单活跃、endpoint 选择正确"，边界是不等于两套生产云 |
| A11 长时间窗口 | **过夜窗口（10h）已完成** | 2026-09-22T01:44Z 结束（`.test-data/acceptance/soak-overnight/evidence.json`，候选 `a5c98e19` **干净工作区**）：**35547s / 2360 采样，css 与 api 重启 0 次**、RSS 峰值 169248KB → 终值 14928KB（对峰值 −91.2%）、FD 38→36、非可信 ingress **2360/2360** 采样可用、入口 40/40。同一次运行的检查里有 2 项失败，都与 soak 无关且已定位：`public-entry-declared-unreachable`（具名 cloudflared 入口当时没有健康 connector，属 provider/边缘侧，harness 自己标注"不要读成隔离失败"）与 `sakura-missing-binary`（同一次运行已有 frpc 在跑，断言被 `frpc-already-running` 抢先；同组 `sakura-refuses-foreign-frpc` 通过）。仍不能证明 24h 尺度极慢泄漏；本次跑的是 N20 修复前的代码，重启路径由 `scripts/accept-supervisor-lifecycle.ts` 单独验收 |
| N16 客户端打包分发 | 设计阶段 | 方案：provider 目录新增"客户端声明 + 解析顺序 + 探测 + `binary-missing` 失败语义"；分发走 npm 平台包（上游 frpc 为 Apache-2.0 可镜像，natfrp fork 需其许可）或引导用户安装；与 ngrok/cloudflared 统一设计 |
| **N20 子服务放弃重启后网关仍报健康** | **已修复并真实验收通过** | 本表上一版记录期间的活实例半死事件（api 子进程 5 次重启失败后 supervisor 放弃，`/service/status` 仍 200、`/api/*` 502 数小时）已作为 N20 记入 [`network-audit-2026-09-19-reconciliation.md`](network-audit-2026-09-19-reconciliation.md) 第 3/4.4/8 节。修复在 `fix/supervisor-lifecycle-n20`（`a8552f1f`，可直接 cherry-pick 到 `origin/main`）：就绪度取自受监督状态、新增 `given-up`、指数退避 + 健康重置、模块解析类失败不再重试、崩溃尾巴脱敏、stop 取消待重启且接受 503。真实验收 `scripts/accept-supervisor-lifecycle.ts` **5/5**（`.test-data/acceptance/n20-live/evidence.json`）：6 次 SIGKILL 窗口内 `/service/status` 全部 503 无一 200 → 报 `api=given-up`（"Exceeded max restarts (budget 5, 6 consecutive failures)"）→ 此时 `/` 仍 200、`/api/network/settings/status` 502 → `xpod stop` 退出码 0、网关 500ms 内退出 |

## 3. 未覆盖边界（如实记录）

1. ~~cloudflared **具名隧道 + Dashboard hostname**~~：**已实测通过**（见上）。过程中修掉两个真实陷阱：Dashboard Service 写成 `https://` 会让 cloudflared 对明文 ingress 做 TLS 握手（边缘只回 502，provider 现在报 `origin-mismatch` 并给出两个地址）；以及 `CSS_PORT`/`API_PORT` 若从操作者 env 继承到候选实例，候选的 **CSS 会占住隧道回源端口**，导致"隧道打到的其实是另一个进程"——harness 现在把候选的 gateway/CSS/API/ingress 全部钉在与隧道回源端口不同的空闲端口上，并在运行中驱逐占用者（`reserveLegPort`）。

**多分支并行注意**（操作者提醒）：同一台机器上可能有多个 worktree/分支各自跑实例，验收 harness 不再假设固定端口可用 —— 每条腿的端口先探测再占用，被占则换端口并在日志里说明占用者；候选实例自带 env，不继承操作者 env 里的 `CSS_PORT`/`API_PORT`。**provider 实现本身的公网入口路径已由 quick tunnel 实测通过**（同一 `LocalTunnelProvider`、同一 ingress、同一隔离矩阵），token/声明入口分支另有单测与失败腿证据（无效 token → `cloudflared exited with code 255`、origin-mismatch 诊断）。
2. Sakura **真实数据面**（需自动 HTTPS + 原生官方客户端或 config 模式结论）。
3. ngrok **固定/保留域名**：本机 agent 为 Free 套餐，明确拒绝自定义 hostname（`ERR_NGROK_314`）；随机域名分支已验。
4. A04 的 AI 四层（需 Provider key）、Cloud-managed canonical Pod 读取（需 Cloud 凭据）、A07（DNS 测试 zone）、A09（双 Cloud）、A11 的 24 小时窗口（需挂机授权）。
5. N16 打包分发（客户端内置）与 W2–W4 其余项（N03/N06/N07/N14/N15/N17/N18/N19）。

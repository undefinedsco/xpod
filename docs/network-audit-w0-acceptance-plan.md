# 联网审查 W0 验收方案（按密钥分级）

- 候选：`release/0.4.11` @ `f4e9e199`（W0 已合并；`d0e1c76e` 修复 + `f4e9e199` 文档）
- 依据：审查报告 [`network-audit-2026-09-19.md`](/Users/ganlu/.codex/worktrees/external-network/xpod/docs/network-audit-2026-09-19.md) 第 7 节验收矩阵 A01–A12；对账 [`network-audit-2026-09-19-reconciliation.md`](/Users/ganlu/develop/xpod/docs/network-audit-2026-09-19-reconciliation.md)；交付 [`network-audit-w0-delivery.md`](/Users/ganlu/develop/xpod/.worktrees/release-0.4.11/docs/network-audit-w0-delivery.md)
- 口径约束：[`docs/cli-dev-testing.md`](/Users/ganlu/develop/xpod/docs/cli-dev-testing.md) 「真实 Xpod 集成验收」——分层报告，不得用隔离测试或替代栈冒充真实实例；证据走 `scripts/release-acceptance-manifest.cjs` 的 schema（它会拒绝含 secret/token/password/api-key 的字段）

## W1/W1+ 已完成的修复（2026-09-20 更新）

三家一起验之前必须修的东西已经落在 `release/0.4.11`（`a260cc6e`、`15c20105`）：

| 报告项 | 修复 |
| --- | --- |
| N09 契约不一致 | 新增 `src/tunnel/TunnelProviderCatalog.ts`：label/凭据键/入口来源/是否可运行/参数字段只声明一次；`/api/network/settings/status` 与 `/api/admin/config` 都下发该目录，设置页与运维页不再维护自己的 provider 清单；API 与 store 也改由目录判定 |
| N09 字段名 | `publicUrl` 成为唯一写入键（runtime 读的就是它），旧 `publicEndpoint` 仍可读入；API 同时接受两种拼写 |
| URL 语义 | 目录声明 `endpointSource`：ngrok 为 `discovered`（不显示输入框），cloudflared/sakura 为 `declared`（可声明、但不代表可达） |
| N08 停用无效 | `XPOD_TUNNEL_PROFILES` 与 `XPOD_TUNNEL_ACTIVE_PROFILE_ID` 改为**按键存在与否**判定权威：空列表不再回退 legacy，`none`/空值即显式关闭；设置页在删除最后一个 profile 时写入 `none` |
| N10 凭据互相覆盖 | 凭据按 profile 存放（`XPOD_TUNNEL_PROFILE_<ID>_TOKEN`），先取 profile 级、再回退 provider 级旧键；删除 profile 时通过显式 removals 一并清除凭据 |
| N11 控件不控制运行 | 证书路径改写真键 `XPOD_ACME_CERTIFICATE_*`；`XPOD_DNS_DOMAIN` 优先于从 `CSS_BASE_URL` 推导；`XPOD_P2P_ENABLED`/`XPOD_P2P_SIGNAL_SERVICE` 真正生效，且 P2P 改为**显式开启**（默认关，符合 N03 未修前的安全要求）；无本地实现的 provider（generic frp）在 API 层明确 400 拒绝，而不是存一个假的"已保存" |
| N13 就绪误报 | `TunnelStatus` 增加 `stage`（process-started / control-connected / proxy-ready / failed）+ `verifiedAt`，`connected` 仅在 proxy-ready；ngrok 不接受本地 agent 地址、不接受裸 "started"、agent 答案必须属于本实例；cloudflared 只在注册连接后算就绪、超时即 failed、退出保留错误；Sakura 不再接管无关 frpc（报 `frpc-already-running`）、登录成功只算控制连接、`start proxy error` 撤销就绪 |
| N12 假可达 | 诊断项改为 `address-configuration`，明说 `configured:`；设置页地址卡片显示"Configured / Not probed"，不再把检查耗时当网络延迟、不再把地址存在当可达 |
| N16 缺二进制 | 三家 spawn ENOENT 统一报 `binary-missing:<provider>:<binary>`（打包仍属产品决策，未做） |

证据：定向 91 文件 / **775 通过**；完整集成 lite 151 通过 / 6 跳过、full 45 通过，退出 0。

**仍未处理（不在本轮）**：N03（raw TCP 无认证加密）、N06（选路校验）、N07（会话并发）、N14（Cloudflare 误删同类型记录）、N15（证书 staging 回退）、N17（数据面限额）、N18（恢复监督/文件权限）、N19（测试入口门禁）；Sakura/FRP 的二进制打包（N16 的产品决策部分）。

## 第六轮补充：A11 短程稳定性（10 分钟）

命令：`bun run accept:network-tunnel --start --candidate-port 3300 --no-a01 --no-identity-chain --no-quick-tunnel --no-real-tunnel --soak-minutes 10`
证据：`.test-data/acceptance/w1-soak-10m/evidence.json`（40 个采样点）。

| 指标 | 结果 |
| --- | --- |
| 子服务重启 | **0 次**（590 秒窗口） |
| 打开文件描述符 | 35 → 34（无增长） |
| 不可信入口可用性 | **40/40 采样全部 200** |
| 常驻内存 | 预热后 78MB → 峰值 171MB → 回落 75MB，净 **-3.5%**（分配器锯齿，非增长） |
| 判定 | 通过；**24 小时窗口仍需你授权挂机**，本探针只是把同一套指标跑满当前会话能承受的时长 |

另外锁定了一条 UI 契约（`ui/src/pages/settings/NetworkPage.test.tsx`）：`discovered` 类型的 provider **不出现**入口输入框、`declared` 类型回显声明值、无本地实现的 provider（generic frp）不出现在下拉里。

## 已执行的验收（2026-09-20，第五轮）

命令：`bun run accept:network-tunnel --start --candidate-port 3300`
候选：`release/0.4.11`（本轮 `78443ebf`），证据 `.test-data/acceptance/w1-round5f/evidence.json`。
**一次运行 48 项检查，全部 PASS，且运行结束不留孤儿进程。**

| 层 | 检查 | 结果 |
| --- | --- | --- |
| 候选自证 / 范围 / P2P | css+api；无 tailscale/relay；`p2p.enabled=false`；身份属于候选域 | PASS |
| **A04** | 真实账号 + Pod（本机候选域）→ 已登录会话 → `PUT 201` / `GET 200` 内容一致 / 匿名读 `401` | PASS |
| 本机 loopback / 不可信入口监听 | 200×5 / 403·403·403·200·200 | PASS |
| **A01 保存** | 设置 API 接受 UI 形状 payload（`activeProfileId` + profile，无 publicUrl） | PASS |
| **A01 契约回读** | 回读为 `accept-a01 · ngrok`，`publicUrl` 未凭空出现（canonical 字段） | PASS |
| **A01 落盘** | `XPOD_TUNNEL_PROFILES` 含 profile、`XPOD_TUNNEL_ACTIVE_PROFILE_ID=accept-a01` 写进 runtime 真正读的那个 env 文件 | PASS |
| **A01 重启就绪** | 重启后候选重新服务 | PASS |
| **A01 连接** | provider 达 proxy-ready 并**自己发现**真实入口 `*.ngrok-free.dev` | PASS |
| **A01 公网矩阵** | 该真实入口：匿名 403 / 伪造 403 / 变更 403 / 显式 token 200 / 普通 200 | PASS |
| **A01 显式关闭** | 关闭配置并再次重启后：隧道 unsupported 且日志无 provider 启动 | PASS |
| 真实 ngrok（独立腿） | 独立候选上同样的入口 + 矩阵 | PASS |
| 真实 cloudflared quick tunnel | `*.trycloudflare.com` 终结在入口监听 + 矩阵 | PASS |
| A08 ×4 | ngrok 错凭据（真实原因）、cloudflared 错 token、ngrok/Sakura 缺二进制、Sakura 拒绝接管外来 frpc | PASS |

**本轮由验收发现并修掉的两个产品缺陷**：
1. **ngrok 会认领别的实例的隧道**：本机 agent API 是机器级共享的（127.0.0.1:4040），一个 spawn 失败（缺二进制/错 token）的 provider 会从那里读到另一实例的公网入口并报 `active`。现在"没有活进程就不采信 agent 答案，且没有活进程不能标记已连接"。
2. **保存的配置写进了 runtime 不读的文件**：设置 API 固定写 `XPOD_ENV_PATH`（回退 `<cwd>/.env.local`），而 CLI 用 `-e custom.env` 启动时并不设置它 → 保存的 profile 永远不生效。现在 CLI 把它实际加载的文件发布为 `XPOD_ENV_PATH`。

**仍未执行**：cloudflared 具名隧道（需 `CLOUDFLARE_TUNNEL_TOKEN` + Dashboard hostname）、Sakura 真实隧道（需 natfrp frpc + 控制台隧道）、A04 的 AI 四层（需 Provider key）、Cloud-managed Local 的 canonical Pod 读取（需 Cloud 凭据）、A07（DNS zone）、A09（双 Cloud）、A11（≥24h；短程探针尚未做）。

## 0. 前置：验收对象必须是候选代码

当前 `http://localhost:3000` 上跑的是**主 checkout**（`release/0.4.5` + 425 个未提交改动），**不是** W0 候选，因此 W0 的四项修复在那上面无法验收。两种走法，二选一：

**A. 独立候选实例（推荐，不动你现在的 :3000）**

```sh
cd /Users/ganlu/develop/xpod/.worktrees/release-0.4.11
git rev-parse HEAD                       # 必须是 f4e9e199
bun install --frozen-lockfile
bun run build:packages && bun run build:ts && bun run build:components
bun --no-env-file src/cli/index.ts start -m local -p 3300 -c config/local.json -e .env.acceptance
curl -s http://localhost:3300/service/status   # 记录 css/api 同源
```

端口取 3300 起（避开 3000、5737–5751 等当前占用）；数据目录用 `.test-data/acceptance/`，验证结束清理。

**B. 用"你实际在用的实例"口径**：把 live checkout 切/并到 `release/0.4.11` 后重启。代价是打断你正在进行的 RC 验收（现在有 `gh run watch` 在跑），且那 425 个未提交改动需要先处理。

> 无论 A 还是 B，"真实 Xpod 分项验收"（运行时/身份/Pod 读写/Gateway 认证/Models/Chat）只在用户实际使用的那个实例上出具；A 方案下我只对**外部服务链路**（隧道、DNS、跨网）出具真实验收，Pod/AI 链路如要在候选实例上做，会明确标注"候选实例"而不是"live 实例"。

## 1. 密钥贴在哪儿：就一个文件

**唯一入口**（仓库根目录，已被 `.gitignore` 第 11 行 `.env.*` 覆盖；`git check-ignore -v .env.acceptance` 已验证）：

```
/Users/ganlu/develop/xpod/.env.acceptance
```

```sh
chmod 600 /Users/ganlu/develop/xpod/.env.acceptance
```

为什么一个就够：

- **候选实例**用它启动，CLI 会把整个文件读进 `process.env` 再传给它拉起的 CSS/API 子服务，所以隧道 token、DNS token、Cloud 凭据、`XPOD_ADMIN_TOKEN` 全部生效：
  ```sh
  cd /Users/ganlu/develop/xpod/.worktrees/release-0.4.11
  bun --no-env-file src/cli/index.ts start -m local -p 3300 -c config/local.json \
    -e /Users/ganlu/develop/xpod/.env.acceptance
  ```
  （`-e` 走 `path.resolve`，绝对路径可用；因此无论从哪个 worktree 启动，都读同一个文件。）
- **验收脚本**读同一个文件。AI Provider key 也写在里面：`scripts/accept-live-gateway-login-chat.ts` 原生支持从环境变量取 `DEEPSEEK_API_KEY`/`KIMI_API_KEY`/`OPENAI_API_KEY`（它自己的 `.test-data/acceptance/provider-api-key` 只是找不到环境变量时的默认查找位置），所以**不需要你维护第二个 key 文件**。
- 真机/异地机参数（`XPOD_P2P_REALNET_*`、`ANDROID_*`）同样写在里面。

**两条注意**

1. 加载逻辑是 `process.env[key] ??= 文件值`，**已导出的 shell 变量优先**。填完文件后确认 shell 里没有旧的 `NGROK_AUTHTOKEN`、`CLOUDFLARE_API_TOKEN` 等残留。
2. 文件里的值我不会回显：只报指纹（`sha256` 前 8 位 + 长度）。也**不要贴在聊天里**（会进会话记录）；万一贴了，用完立刻轮换。

**给密钥的三条命名纪律**

- DNS token 只授权**测试 zone**（不要生产根域、不要给 Tencent 生产 token）。
- 隧道用独立 authtoken，可随时在控制台撤销。
- `XPOD_ADMIN_TOKEN` 只给候选实例用，**不要**用 live 实例的那一个。

### 1.1 文件模板：只需要你填一行

```dotenv
# 必需：造出"真实公网入口"，否则 N01 的远端半边只能靠隔离测试
NGROK_AUTHTOKEN=
# 或（二选一，不要同时填）：CLOUDFLARE_TUNNEL_TOKEN=

# 可选：真实 DNS 记录验收（A07 / N02 真实 A/B），需配合一个测试 zone
# CLOUDFLARE_API_TOKEN=

# 可选：经隧道的"显式授权管理仍正常"正向对照；值由我自己随机生成即可，
# 不需要你的任何生产秘密。不填则只验本机 loopback 正向对照。
# XPOD_ADMIN_TOKEN=
```

> `CLOUDFLARE_TUNNEL_URL` / `SAKURA_TUNNEL_URL` **不用填**（见 1.3）：cloudflared/Sakura 的域名在控制台侧，Xpod 只把它写进 status/DDNS 诊断显示，不影响隧道是否可用。我只需要**知道**那个 hostname 才能从公网发请求——你直接告诉我就行（它不是秘密）。ngrok 连这个都不需要，provider 自己会发现。

### 1.2 为什么需要 / 为什么不需要（逐键说明）

| 键 | 必要性 | 作用与代码依据 |
| --- | --- | --- |
| `NGROK_AUTHTOKEN`（或 `CLOUDFLARE_TUNNEL_TOKEN`） | **必需** | 唯一目的是造一条**真实公网入口**。N01 的结论是"远端转发被误判为本机"，没有真实隧道就只能验本机半边。`resolveLocalTunnelProvider()` 在没给 provider 时按 token 自动选：有 `NGROK_AUTHTOKEN`→ngrok，有 `CLOUDFLARE_TUNNEL_TOKEN`→cloudflare（`local.ts:304-312`）。**这条验收能区分修复前后**：修复前从公网 URL 打 `/api/admin/status` 会 200（隧道从 loopback 接入），修复后必须 403 |
| `CLOUDFLARE_API_TOKEN` | 可选 | **DNS 记录**凭据，不是隧道凭据。local 模式的自建 DNS（`CloudflareDnsProvider`）读它（`container/index.ts:203`），用于 A07（增删改 zone diff、MX/TXT 保留 = N14 复现）和 N02 的真实 DNS 写入。只测隧道不需要它 |
| `XPOD_TUNNEL_PROFILES` / `XPOD_TUNNEL_ACTIVE_PROFILE_ID` | **不用填**（我上一版写错了） | 它们是**设置页/API 的产品路径**写出来的多 profile 配置；验收不需要。单独一个 `NGROK_AUTHTOKEN` 就会走 legacy 单 provider 路径自动生效 |
| `XPOD_CLOUD_API_ENDPOINT` | **不用填**（你说得对） | 从 OIDC issuer 推导：`cloudApiEndpointFromIssuer(oidcIssuer)`，默认 `https://api.undefineds.co`（`oidc-issuer.ts:39`、`container/index.ts:136-139`） |
| `XPOD_NODE_ID` / `XPOD_NODE_TOKEN` / `XPOD_SERVICE_TOKEN` | **不用填**（你说得对） | 由服务/门户统一管理：`autoProvisionFirstRunLocal()` 在 `nodeToken && serviceToken` 且无需刷新时直接短路复用（`api/runtime.ts:62-74`）。只有"让候选实例以**新测试节点**身份注册到 Cloud"才需要一次性 `XPOD_PROVISION_CODE`；不给，Tier 3 就标未覆盖，W0 四项修复不受影响 |
| `XPOD_ADMIN_TOKEN` | 可选，且**不需要你的秘密** | 它是每实例自带的管理凭据，我给候选实例随机生成一个即可。价值仅是正向对照：经隧道**带** token 允许、**不带**拒绝，证明隧道不是被一刀切封死。不填则只验本机 loopback 正向对照 |
| `DEEPSEEK_API_KEY` 等 | 可选 | 只用于附加的 AI 链路验收（Tier 4），与 W0 无关 |

> 一句话：**除了一行隧道 token，其余都可以不填**；不填的键对应验收项直接标"未覆盖"，而不是失败。

### 1.3 三家隧道各自要什么，以及 URL 从哪来

| provider | 必需凭据 | 公网 URL 从哪来 | 本机现状 |
| --- | --- | --- | --- |
| **ngrok** | `NGROK_AUTHTOKEN` | **provider 自己发现**：`NgrokTunnelProvider` 查本地 agent API（`/api/tunnels`）并解析日志里的 URL——什么都不用填 | 已装 ✔ |
| **cloudflared** | `CLOUDFLARE_TUNNEL_TOKEN` | **控制台侧**：hostname 在 Cloudflare Dashboard 的 tunnel 配置里；`LocalTunnelProvider.start()` 只传 `tunnel run --token <token> --url <本地入口>`，**不传域名**，`CLOUDFLARE_TUNNEL_URL` 只落到 `status.endpoint`／DDNS 诊断显示 | 已装 ✔ |
| **Sakura FRP** | `SAKURA_TUNNEL_TOKEN`（legacy 亦认 `SAKURA_TOKEN`） | **控制台侧**：命令就是 `frpc -f <token>`，域名/remote port 都在 Sakura 控制台配；`SAKURA_TUNNEL_URL` 同样只是显示用 | 需 natfrp 专用 frpc（Homebrew 的通用版不接受 `-f <token>`）✘ |

**那"心跳上报"呢？** 分两种情况，代码事实是：

- **managed 节点（Cloud 代管）**：公开地址由 Cloud 在注册时下发（`XPOD_PUBLIC_URL` / `spDomain`）并作为 canonical URL；用户不需要填任何 URL —— 这部分和你的判断一致。
- **本地用户隧道（ngrok/cloudflared/Sakura）**：当前心跳**不带**它们。`EdgeNodeAgent.buildTunnelHeartbeatPayload()` 只上报 **frp manager** 的 client 状态（那是 Cloud 下发 FRP 配置的路径，`EdgeNodeAgent.ts:592-598`），本地隧道的 endpoint 只存在于 provider status 里（`LocalTunnelProvider.ts:174`）。
- 所以：ngrok 靠 provider 发现；cloudflared/Sakura 靠控制台——**要发公网请求的人得先知道域名**，但那是"告诉我一个域名"，不是"填一个凭据"。

**建议**：W0 的 N01 远端半边用 **ngrok 一家**就能闭环（token 一行、零安装）。要按报告 A01「三家各自」的口径，则再加 **cloudflared**（已装，但你需要在 Dashboard 给我一个 hostname）。**Sakura 建议留到 W3**：它的就绪判定本身是未修的 N13（任意 frpc 进程会被接管、`login to server success` 即判 connected、`start proxy error` 后仍可能 connected），现在验出来的是 N13 缺陷而不是 W0 回归；若你仍要现在验，它的价值是给 N13/N16 留真实失败证据，但需要先装 natfrp 的 frpc 并配好隧道。

### 1.4 产品端今天让用户填什么（现状与差距）

设置页的隧道卡片（`ui/src/pages/settings/NetworkPage.tsx:371-379`）今天让用户填三样：**Provider 下拉 + "Public endpoint" + Credential**（外加 provider 参数）。也就是说"让用户填 URL"确实是现状，但它有三个已知问题，都属 W1/W4，W0 没动：

1. **填了也到不了 runtime**：UI 存 `publicEndpoint`（:372/:379），store 原样写进 `XPOD_TUNNEL_PROFILES`（`NetworkEnvironmentConfigurationStore.ts:77-78`），而 runtime 读的是 `publicUrl`（`TunnelProfiles.ts:144/168`）→ endpoint 恒为空。这就是报告 N09。
2. **本来就不该由用户填**：ngrok 的 URL 由 provider 自发现；cloudflared/Sakura 的域名是控制台事实。用户真正必须提供的只有**凭据**。
3. **Sakura 用户今天根本配不了**：下拉只有 ngrok/Cloudflare/frp（:371），store 白名单同样只有这三家（`:93`），而 Local 侧实际注册的是 ngrok/cloudflare/**sakura_frp**（`local.ts:64/75/85`）——UI 的 "frp" 在 Local 没有任何注册。Sakura 目前只能靠 env 配置。

**因此本方案的验收不走"设置页填 URL"这条路**（那条路今天注定给出假结论），只用 env 提供凭据；等 W1 把契约统一（一个语义一个键、URL 改为发现/声明并标注验证状态）后，产品端路径才值得纳入验收用例。

## 2. 密钥能多完成哪些验收

### Tier 0 · 不需要任何密钥（现在就能做，约 40 分钟）

| 项 | 内容 | 我怎么做 |
| --- | --- | --- |
| 自动化门禁复跑 | 定向 419 项 + 完整集成（lite 151/6、full 45） | 已知通过；验收时对候选 SHA 再复跑一次并记录 |
| A02 | None / 删除全部 / legacy 残留 → 重启后无进程、无 active route | 候选实例 + 本地 profile 操作 |
| A12 | 无 Tailscale 入口、无自动 Xpod relay 兜底、不支持的 FRP profile 不假配置 | 源码路径 + 候选实例行为 |
| N01 本机半边 | 入口监听（远端语义）与主监听（本机语义）判定差异 | `curl` 候选实例两个端口，对比 403/200 |
| N05 负例 | 私网/元数据/重定向进私网被拒 | 候选实例 + 节点心跳伪造候选地址，看 `blocked-target:*` |

### Tier 1 · 一个隧道凭据 → 多完成（我能全自动，约 30 分钟/家）

- **A01**：该家 provider 的"配置 → 应用/重启 → 真实公网入口 → 进程归属"（只需 token，provider 自动选中）。
- **A06（真实入口半边）**：从**公网 URL** 打管理面矩阵——匿名、普通 WebID、跨账号、伪造 `Host`/`X-Forwarded-*`/内部标记，全部必须 403；对照组是本机 loopback 200。这是 N01 修复唯一能闭环的真实验收。
- **A08**：错 token、进程被杀、端口冲突、缺二进制 → 阶段化错误码与"真实未就绪"。
- **N01 回归补证**：`scripts/ngrok-tunnel-smoke.ts` 已有 ngrok 侧 caveat 说明（免费 dev 域不是 canonical Solid 源），我会按它区分"原生/调试验收"与"浏览器 canonical 验收"。

> 本机已装 `ngrok`、`cloudflared`（`/opt/homebrew/bin`）；`frpc/frps` 未安装 → Sakura/FRP 要么先装，要么本轮排除并写明。

### Tier 2 · DNS 凭据（测试 zone）→ 多完成（我能全自动，约 45 分钟）

- **A07 记录半边**：新增/更新/删除前后的 zone diff；**MX/TXT 必须保留**（N14）；根域与 A/AAAA 双栈；失败重试不误删。
- **N02 真实 A/B**：两个节点身份（`XPOD_NODE_ID`/`XPOD_NODE_TOKEN`）互相尝试改写对方 subdomain → 必须被拒；无绑定时跳过。
- **A07 证书半边（可选）**：DNS-01 签发 + 续期阈值后的外部 TLS 观察（需要可签证书的测试域名；我会先确认你是否允许对该 zone 签证书）。

### Tier 3 · 真实 Cloud/身份凭据 → 多完成（约 60 分钟）

- 前置：需要一次性 `XPOD_PROVISION_CODE` 把候选注册成**新测试节点**（不复用你 live 节点的身份）；不给就跳过本层。
- **A04 的 Cloud-managed Local 部分**：Cloud canonical Pod URL 发起读取，记录 SDK 最终目标 URL，必须落到本地 Gateway 且返回真实 Pod 内容。
- **managed-local 注册/续期、节点发现/心跳** 端到端（N02 的上游）。
- **A09 并发半边**：我会用 docker compose 起两套 Cloud + 两套 PG 做副本并发；这只证明并发语义，**不等于**生产双 Cloud 验收。

### Tier 4 · AI Provider key → 多完成（约 20 分钟）

- 强制证据链第 4–7 层：Pod 内写入 provider 配置 → Gateway client-credentials 认证 → `/v1/models` → `/v1/chat/completions`（含流式）。
- 现成入口：`scripts/accept-live-gateway-login-chat.ts`（自带撤销与清理），它直接从同一份环境读 `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`KIMI_API_KEY`。
- W0 不涉及 AI；这条是"联网发布是否影响 AI 链路"的附加验收，若 AI 不在本轮范围可跳过。

### Tier 5 · 密钥解决不了，必须你参与

- **A05 / A10**：两个真正独立的外网（蜂窝热点/异地机器）与 P2P 数据面；Android 真机需要 `adb` + 安装 APK（`scripts/p2p-android-realnet-smoke.ts`）。
- **A11**：≥24h 观察窗口 + 休眠唤醒/断网重连；需要挂机时间且机器不休眠。
- **第三方控制台语义**：隧道侧撤销设备、Cloudflare 侧记录归属与 zone 代理状态、ngrok 免费域限制——我只能看 API 结果，控制台状态需要你确认。
- **签名/安装体验**：DMG/ZIP 未签名未公证、Gatekeeper/SmartScreen、安装向导。
- **live 实例的用户数据**：我不会碰你现有实例的账号/Pod，除非你明确指定某个测试账号。

## 3. 执行批次与产物

| 批次 | 范围 | 需要密钥 | 预计 | 产物 |
| --- | --- | --- | --- | --- |
| B0 | 候选构建与运行时自证（SHA、build 日志、`/service/status`） | 无 | 10 min | `.test-data/acceptance/B0/` |
| B1 | Tier 0（A02/A12/N01 本机/N05 负例 + 门禁复跑） | 无 | 40 min | manifest + 脱敏日志 |
| B2 | Tier 1 每家隧道（A01/A06/A08） | 隧道 token | 30 min/家 | 公网 URL、请求矩阵、进程归属 |
| B3 | Tier 2 DNS（A07 + N02 A/B） | DNS token + 测试 zone | 45 min | zone before/after diff、拒改证据 |
| B4 | Tier 3 Cloud/身份（A04 半边、managed-local） | Cloud 凭据 | 60 min | 目标 URL 追踪、Pod 读写记录 |
| B5 | Tier 4 AI 链路（可选） | Provider key | 20 min | 四层分项报告 |
| B6 | Tier 5 人工项（跨网/真机/24h） | 你的手和时间 | 你定 | 你提供的截图/日志，我整理 |

每批结束我都会给出：**通过 / 失败 / 未覆盖** 三态清单 + 与报告的 N0x、A0x 对应关系 + 下一步阻塞项。证据只放脱敏后的状态码、URL、时间戳、SHA/digest 与指纹，不放明文凭据。

## 4. 我需要你先回答三件事

1. **验收对象**：走 A（`release/0.4.11` 独立候选实例，端口 3300，不动现在 :3000）还是 B（把 live 切到 0.4.11 重启）？
2. **隧道范围**：只验 ngrok（已装、最快），还是 ngrok + cloudflared？Sakura/FRP 要不要装客户端一起验？
3. **DNS 测试 zone**：给我一个专用测试 zone 名 + `CLOUDFLARE_API_TOKEN`（只授权该 zone）？是否可以对该 zone 做 ACME DNS-01 签发？

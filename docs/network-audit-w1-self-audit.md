# W1 自检结论：配置与 provider 统一契约

- 目标：联网审查报告 W1 工作包（N08–N11 + "三家可验"所需的 N13/N12/N16 检测部分）
- 代码：`release/0.4.11` @ `68be4d13`（W1 分支 `codex/network-audit-w1` 同点）
- 验收证据：[`network-audit-w0-acceptance-plan.md`](network-audit-w0-acceptance-plan.md) 与 `.test-data/acceptance/*/evidence.json`
- 自检方式：逐条对照目标里的九项要求，在代码里找"是否只剩一处声明 / 是否真被消费 / 是否有负向回归"，并对已修项复跑门禁

## 1. 九项要求逐条结论

| # | 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 单一 provider 目录 | **达成**（用户界面与服务端） | `src/tunnel/TunnelProviderCatalog.ts` 是唯一声明；`/api/network/settings/status` 与 `/api/admin/config` 下发它；设置页、运维状态页、store 白名单、API 校验、provision 解析、runtime 取值全部改由它判定。运维页仍保留一份展示字段表（退场页面，不再扩展），但**凭据键改为消费 API 投影**（见第 3 节第 4 条） |
| 2 | `publicUrl` 字段统一 | **达成** | 写入只产生 `publicUrl`（store/UI）；`publicEndpoint` 仅作旧数据读取兼容（`TunnelProfiles.ts:142-144`、store `:145`、API 校验接受两种拼写）；UI 测试锁死"保存的是 canonical 字段" |
| 3 | URL 改为发现/声明 | **达成** | 目录用 `endpointSource: discovered | declared` 声明；ngrok 走 provider 发现（并对 agent 答案做归属校验），cloudflared/Sakura 为控制台声明；UI 对 discovered 不渲染输入框（有测试） |
| 4 | 停用权威 | **达成** | `XPOD_TUNNEL_PROFILES` 与 `XPOD_TUNNEL_ACTIVE_PROFILE_ID` 均"按键存在与否"判定；空列表不回退 legacy，`none`/空值即显式关闭；store 删除最后一个 profile 时写入 `none`；真实验收里"配置过再显式关闭并重启"也验过（`a01-explicit-off-after-config`） |
| 5 | profile 级凭据隔离 | **达成** | 凭据存 `XPOD_TUNNEL_PROFILE_<ID>_TOKEN`，解析顺序 profile → provider 旧键；删除 profile 通过 removals 清除自己的凭据；**provider 构造真正拿到该凭据**（第 3 轮修的真实缺口，有回归） |
| 6 | DNS/HTTPS/P2P 控件逐字段定性 | **达成** | HTTPS：证书路径改写 runtime 真读的 `XPOD_ACME_CERTIFICATE_*`；DNS：域名优先 `XPOD_DNS_DOMAIN`，且**选中的 provider 真被装配**（Cloudflare/Tencent，均有回归）；P2P：`XPOD_P2P_ENABLED`/`XPOD_P2P_SIGNAL_SERVICE` 生效，且**默认关闭**（N03 未修前的安全默认）；无本地实现的 provider（generic frp）在 API 层 400 拒绝 |
| 7 | N13 就绪状态机 + 不接管无关 frpc | **达成** | 三家统一 `stage`（process-started/control-connected/proxy-ready/failed）+ `verifiedAt`；超时是可见失败；ngrok 不接受本地 agent 地址、不认领无进程时的 agent 答案；Sakura 遇外来 frpc 报 `frpc-already-running`；cloudflared 只在注册连接后算就绪；每家都有负向回归 |
| 8 | N12 状态不再假可达 | **达成** | 诊断项改名 `address-configuration` 并只说 `configured:`；地址卡片显示 "Configured / Not probed"，不再把函数耗时当延迟；capability 暴露 `stage`/`endpoint`/脱敏 `detail`；概览卡改为 "Preferred access path"+configured 措辞并明说"配置不等于探测结果" |
| 9 | N16 缺二进制检测 | **达成（检测部分）** | 三家 spawn ENOENT 统一报 `binary-missing:<provider>:<binary>` 并经 API 暴露；ngrok/Sakura 有真实失败腿验收。**打包分发仍未做**（产品决策） |

## 2. 门禁与验收现状

- 门禁：定向 **207 文件 / 1848 通过**；完整集成 lite 151 + full 45，exit 0；`build:ts`、`build:components`、`build:ui` 全过。
- 真实验收（一次运行 48 项全过）：A04 本地三层（身份/会话/Pod 读写/匿名拒绝）、A01 全链路（设置 API 保存 → 契约回读 → 落盘 → 重启 → provider 达 proxy-ready → 真实公网入口矩阵 → 显式关闭后仍关闭）、**真实 ngrok 入口**、**真实 cloudflared quick tunnel 入口**、A08 四条失败腿、A02/A12/P2P 默认。
- 稳定性：10 分钟 soak（40 采样）无重启、FD 平稳、入口 40/40 可用；RSS 为分配器锯齿（净 -3.5%）。

## 3. 未覆盖边界（如实记录）

1. **cloudflared 具名隧道**：quick tunnel 已证公网入口路径，但"具名隧道 + Dashboard hostname + 声明入口"这一分支需要 `CLOUDFLARE_TUNNEL_TOKEN`（`.env.acceptance` 中该值为空）。
2. **Sakura 真实隧道**：就绪/接管/缺二进制已验；真隧道需要 natfrp 版 `frpc`（Homebrew 的通用 frpc 不接受 `-f <token>`）与控制台隧道配置。
3. **ngrok 固定/reserved 域名**：本机 agent 账号为 Free 套餐，`ERR_NGROK_314` 明确拒绝自定义 hostname；随机域名分支已验。
4. **运维页仍是第二张表（已收敛凭据键，仍未接目录）**：`ui/src/pages/admin/SettingsPage.tsx` 自己维护 provider 展示字段表，并继续写 `XPOD_TUNNEL_PROFILES`/`XPOD_TUNNEL_ACTIVE_PROFILE_ID` 这类共享键，因此在设置页与运维页都配置时会互相覆盖——这一层未消除（AGENTS.md：旧 Admin Console 已退场，不在仓库内扩展 UI）。
   但**同 provider 两 profile 共用一个 secret 的真实缺陷已修**：`/api/admin/config` 现在投影运维页可用的 profile 事实（含每个 profile 自己的 `credentialEnvKey`、`credentialConfigured`、`active`，来自 `projectTunnelProfiles()`），运维页读该投影写凭据，不再自己拼 provider 全局键；回归见 `tests/api/handlers/AdminTunnelProfileProjection.test.ts`（两条 ngrok profile 必须拿到两个不同的键）。
5. **A04 的 AI 四层与 Cloud-managed canonical 读取**：需要 Provider key / Cloud 凭据，未执行。
6. **A07（DNS 真实 zone）、A09（双 Cloud 并发）、A11 的 24 小时窗口**：分别需要测试 zone、第二套 Cloud、挂机授权。
7. **N16 打包分发**、以及 W2–W4 的其余项（N03/N06/N07/N14/N15/N17/N18/N19）不在 W1 范围。

## 4. W1 是否可判定完成

- **修复部分**：九项要求全部达成，每项都有负向回归与门禁证据 → 可判定完成。
- **"三家一起验"部分**：ngrok 完成；cloudflared 完成"真实公网入口"但缺"具名隧道配置链路"；Sakura 完成失败与就绪语义但缺真实隧道。结论：**在拿到 `CLOUDFLARE_TUNNEL_TOKEN`（+ 控制台 hostname）与 natfrp frpc 之前，三家统一验收不能判为全部通过**，只能判为"1 家完整 + 1 家部分 + 1 家语义层"。
- 下一步最小解锁动作：把两个 token 值填进 `.env.acceptance`（Sakura 另需装客户端），然后 `bun run accept:network-tunnel --start --candidate-port 3300`；harness 会把未覆盖项自动变成实测。

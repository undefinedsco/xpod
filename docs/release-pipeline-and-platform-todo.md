# 发布流程与平台 TODO（2026-11-24）

来源：2026-11-22 至 11-24 的流水线诊断、发布修复与 pi 迁移讨论。完成一项就勾掉，并写上 PR 或提交。

## 集群凭据

背景：GitHub 的仓库级和环境级密钥不能跨仓库共享，同一份广州集群凭据被复制了 7 处。在集群侧重新生成 kubeconfig 后，GitHub 上的旧副本全部失效，0.4.37 的 RC 因此在前置检查被拒（`Unauthorized`）。cn 与 rc 是同一个广州集群（`gzg.sealos.run`，命名空间 `ns-iknkxtc8`），部署配置有差异。

- [x] xpod `rc` 环境 `KUBE_CONFIG_DATA`（11-24 已更新）
- [x] xpod-pro 仓库级 `KUBE_CONFIG_DATA`（11-24 已更新；Private17、PG17 发布与搬运都读这一份）
- [x] xpod `cn` 环境 `KUBE_CONFIG_DATA`（11-24 已更新）
- [x] xpod `co` 环境 `KUBE_CONFIG_DATA`（11-27 已更新；v0.4.37 发布部署 `.co` 时因它过期失败，之前漏列）
- [ ] xpod 仓库级 `KUBE_CONFIG_DATA`（10-23 旧值，`guangzhou-test.yml` 用）
- [ ] xpod-pro `SEALOS_CN_KUBECONFIG`（09-02 旧值，PG17 发布的对等检查用）；改为读同一份仓库级凭据后删除
- [ ] LinX `rc` / `prd` 环境（11-08）：确认是否同一集群，是则更新
- [ ] 删除没有作业读取的副本：xpod-pro `rc`、`qlever-rc` 环境的 `KUBE_CONFIG_DATA`
- [ ] xpod 与 LinX（公开仓库）改用组织级密钥，每个集群一份；需要组织管理员设置。xpod-pro 是私有仓库，Free 套餐下不能用组织级密钥，保留一份仓库级
- [ ] 轮换脚本：输入 kubeconfig 与集群名，写入该集群的全部副本，并逐个 `kubectl auth can-i` 验证
- [ ] 凭据对照表写进 `docs/RELEASE.md`：每份副本的位置、读取它的作业、对应集群

## 发布流水线

- [x] RC 自行触发 Private17 证明（#226）
- [x] RC 部署不再等 macOS 兼容通道；只读 `gh` 调用遇 5xx 重试；版本 0.4.37（#228）
- [x] Node 只测一个滚动 LTS（24）；PR 兼容通道只跑 Linux；单元测试按范围跑（#230）
- [x] 0.4.37 RC 通过并正式发布（.co、.cn、桌面版均完成，2026-11-27）
- [x] Bun 专用测试并行执行、单元测试分三片（#234 已合入；实测整轮 9 到 12 分钟，原 24 分钟）：必需检查 `test` 原来 24 分钟，其中单元测试 10.2 分钟、Bun 专用测试 6.6 分钟串行；现在原 `test` 改名 `checks`，单元测试拆到 `unit` 三个分片，新 `test` 汇总两者，必需检查名不变
- [x] 正式桌面版「权限与操作验收」不稳定：查明 11-16、11-17 的 5 次失败是三种不同原因（网关启动 60 秒未就绪、`provider-create`、`provider-publication`），11-18 修复后通过，此后没有新的样本；RC 里同一验收近 15 次只失败过 1 次。RC 的多次重跑主要来自 macOS 兼容通道（#228 已移出部署路径）和 Private17（#226 已自动化）。下次正式发布若再失败，按失败摘要里的 `stage`/`evidence` 定位
- [ ] macOS arm64 作业排队 15 分钟后被取消（本轮 AFS 两次）：GitHub 注释为「The job was not acquired by Runner of type hosted even after multiple attempts」，是 GitHub 托管 macOS arm64 容量不足，手动重跑可过。可选：对这一注释的失败自动重跑一次；根本办法见下面 Mac mini 自托管
- [ ] RC 用户流 `rc-browser-consent` 偶发计数为 0（页面侧计数器在同意页出现前没装上就记 0，按设计 fail-closed），重跑可过；需要让计数器在导航前安装到位（2026-11-28，run 46119636112 第 1 次）
- [ ] pi 1.6 升级（e24d54d88）后 `pi-coding-agent` 不再依赖 `extract-zip`，API 产出的 `notices` 阶段因间接依赖 `yauzl` 消失而失败（staging RC 46174499559 桌面构建、API 产物 46172942298）；#246 显式声明 `yauzl`。教训：改依赖的 PR 应跑一次 API 产物构建
- [ ] `owned-mode-command-input.node-test.cjs`「a short-lived same-group descendant drains naturally」偶发失败（本地 3 次失败 1 次），时序相关
- [ ] QLever `test_qlever_audit_site_diagnostic` 的 `NativeAuditTimer.test_real_owned_timer_keeps_primary_and_nonlease_closing` 偶发失败（`summary()` 返回 None；依赖 0.9 秒真实计时窗口，CI 负载高时时序相关；2026-11-28，#247 第 1 次）
- [ ] RC 70 分钟的关键路径是 macOS 桌面构建（3→57 分钟）加桌面验收（57→69）；部署、三模式验收、Private17 那条链 55 分钟已结束。桌面构建里「从干净源码产出 API 能力」占 27 分钟（各阶段分散：打包 4.3、Inngest 输入 4、stage 3 分钟等，没有单点可砍）。结构性办法是按「可选组件」方向让桌面不再内置 API 模块、改为按需下载，RC 可省约 27 分钟；属于产品方向变更，待确认
- [ ] CI 工具链从 Node 22 统一到 24，`engines` 改为单一 LTS（约 35 处；对 npm 用户是破坏性变化，单独 PR）
- [ ] 决定是否把 Mac mini 注册为自托管 runner，专供桌面构建和验收，不再占 GitHub 的 5 个 macOS 名额
- [ ] xpod-pro `test_dispatch_inputs_are_immutable_and_revision_pinned` 在 main 上本来就失败（`installed_service_image` 有默认值），修正断言

## 可选组件（CLI / AFS / CSS / API）

方向：主程序尽量轻，这几个模块作为可选组件按需下载，以后并入插件中心。

- [ ] 现状：四个模块包从未发布到 npm；自 `782e247da`（11-13）起，产物构建与挂载验收只在手动触发时运行，之后没人触发过，PR 上只跑约 10 秒的契约检查
- [ ] 把模块产物构建、安装验收和发布接回 RC 与正式发布，作为必需项（按 `docs/module-distribution.md`）
- 2026-11-24 在 staging `c33f7427` 手动触发的第一层（产物构建）结果：
  - [x] API：四个平台构建成功（run `45313593555`）
  - [x] CSS：darwin-arm64 构建成功（run `45313588784`）
  - [ ] CSS：linux-x64、linux-arm64、darwin-x64 还没有原生构建来源，CSS 模块目前只支持 Apple Silicon Mac
  - [x] **AFS 挂载验收四个平台全部失败**（run `45313598062`）：`scripts/agentfs-native-ci/mounted/native-authority.json` 写死了 11-09 run `42630283454` 的原生产物，而这类产物只保留 14 天，已过期删除（下载 404）。短期：重跑 `agentfs-native-acceptance.yml` 并重新写入（该文件被 2 处记录写死哈希，先确认是否冻结）；长期：验收依赖的原生产物改存 GitHub Release 附件，写死附件摘要，不依赖临时产物
  - [x] AFS：`codex/afs-native-runner-refresh`（#233）已用 run `45440938245`（四平台，含 `supervisor-units` 阶段）重新写入 `native-authority.json`；挂载验收 run `45494179613` 四平台通过，#233 已合入
- [ ] 第二层：用实际产物做安装验收（`module-installed-consumer`）
  - [x] 下载超时：产物下载固定 60 秒上限（含响应体），CSS 1.3 GiB、API 1.9 GiB 必然超时；改为按产物大小放宽（#235）
  - [ ] **CSS、API 产物不合格**：darwin-arm64 包里带了其他平台的原生文件（`@anthropic-ai/claude-agent-sdk/vendor/ripgrep` 10 个、`koffi` 16 个），安装验收与准入都会拒绝；另有 universal Mach-O（`fsevents`、`clipboard-darwin-universal`）被规则误拒。修复在 `codex/module-foreign-natives`：打包时丢弃不能在目标平台加载的原生文件并记入 provenance，universal 含目标切片即通过。还差：为改动的 `physical-module-stage.ts` / `physical-module-native.ts` 追加源绑定登记（目前 56 个登记测试失败），然后重建 API（四平台）与 CSS 产物再跑安装验收。登记同样钉住 `package.json` / `bun.lock`，建议在 pi 升级合入后一次做完
- [ ] 第三层：功能验收——CLI 登录后读写 Pod；AFS 挂载；CSS、API 作为服务模块启动后登录、读写 Pod、真实 Chat
- [ ] 第四层：桌面按需下载模块并组合运行
- [ ] 补 RC 端到端验收：定时任务加进程重启后续跑；真实 Pod 上的全文与向量搜索

## 规格

- [ ] 审阅并提交 `docs/pi-native-provider-integration.md`（M、D 线）
- [ ] 审阅并提交 `docs/external-agent-executors.md`（X 线）
- [ ] Matrix 群聊服务授权（LinX 交来的 `docs/group-chat-service-access-spec.md` 的 xpod 侧）：需要决定是否新增部署级服务身份，与 `docs/pod-interface-key.md`「不引入部署级服务身份」冲突；推荐新增，待裁决

## pi 迁移

- [ ] P1：升级到 `@earendil-works` 1.6.0（pi-ai、pi-agent-core、pi-coding-agent、pi-durable）
- [ ] P2：每连接隔离的 `CredentialStore`，订阅 OAuth 改用 pi-ai，按 §5.4 准入
- [ ] P2：按接入原则（主规格 §0）下线目录中的 Anthropic `official-subscription`；已有该类连接的用户提示改用 API Key 或 Claude Code 执行器
- [ ] P2：删除目录里按厂商写死的分支（`provider-catalog.ts` 中 `if (provider === 'openai' …)` 等），认证交给 pi-ai 后不再需要
- [ ] OpenAI 订阅：本机（桌面/Local）经 pi-ai 直接可用；Cloud 托管需申请本产品的官方接入，获批前 Cloud 不提供，用户经自己设备上的 Xpod 使用
- [ ] D1：pi-durable 替换自写续跑与整轮重跑，Inngest 只负责触发与投递

## 2026-11-25 RC 稳定性

staging 上连续几轮 RC 失败，原因都在外部，已逐个处理（只重试暂时性错误，真错误照常失败）：

- [x] 上游模型 `linx-lite` 偶发 503：RC 内置模型 Chat 检查只对 429/502/503/504 重试（#236）
- [x] MinIO 写入断连导致 Pod 写 500：16 MiB 以内的写入缓存后对网络层错误重试（#237，产品侧也受益）
- [x] macOS arm64 机器分不到被取消：新增工作流，对「未分到机器」的首次失败自动重跑一次（#237；`workflow_run` 只认默认分支，`main` 同步后才生效）
- [x] Private17 准入读 GitHub API 遇到 500：只对读请求重试，dispatch 与上传不重试（#238）
- [x] 验证：staging 265391e 的 RC（run `45661185693`）第 2 次尝试全部通过；第 1 次只因 macOS 机器未分到而取消
- [ ] 正式环境里 `linx-lite` 的上游 503 仍会直达用户，建议在部署侧 ai-gateway 配置回退或重试

## v0.4.37 正式发布（2026-11-26 至 11-27）

- [x] tag 推送，npm 提升为 latest，GHCR 镜像 `sha256:ff86d0ef…2ef268` 提升
- [x] `.co` 部署（第 3 次尝试成功；前两次分别因 `co` 凭据过期、写错账号的 kubeconfig 失败，都停在部署前，线上未改动）
- [x] `.cn` 部署（tag 发布不会自动部署 `.cn`，按惯例手动触发 `deploy.yml`，run `46036508191`）
- [x] macOS 桌面版：加 `v0.4.37` 精确 tag 策略后重跑通过，GitHub Release 含 dmg、zip 与 `latest-mac.yml`；临时策略已删除，`rc` 恢复为只放行 `staging`

发布清单（这次漏掉的两步）：
- [ ] 推 stable tag **之前**：给 `rc` 环境加这一个 tag 的精确策略，读回确认（见 `docs/RELEASE.md`），桌面发布结束后删除
- [ ] tag 发布完成后：用同一个镜像 digest 手动触发 `deploy.yml` 部署 `.cn`
- [ ] 后续可考虑把这两步写进发布流程本身，减少人工步骤

## 模块发布 v2（2026-11-28 决定方案 B）

方案见 `docs/module-publication-v2.md`：逐文件登记的中央准入换成 CI 构建 + 包检查 + 安装验收 + `npm publish --provenance` + 回读验收，服务 RC/stable 不在范围内。

- [x] S1 包检查与安装验收脚本独立成命令（#239）
- [ ] S2 新发布工作流，先用 CLI/client 跑通到 `next` 并提升（工作流 #240；provenance 需要 `repository.url`，#243 在打包清单里写入；首次发布待重跑）
- [ ] S3 API 瘦身（他平台原生文件、源码归档移出运行包、ACP 适配器移出），等 pi 升级合入
- [ ] S4 API/CSS/AFS 四平台首发
- [ ] S5 桌面去掉 API 预置，改按需下载；RC/stable 桌面构建删去 API 构建
- [ ] S6 删除旧独立发布工作流与只服务模块发布的准入代码
  - **提前**：旧准入里 API 构建流水线的"完整源码配方"（`module-source-phases.ts` / `github-origin.ts`）逐字节绑定 CLI/client 的 `package.json`，RC 桌面构建也走同一检查。结果是 CLI 每升一次版本，API 配方和 RC 桌面构建就会失败，CLI 实际上无法独立发版。先解开这层依赖：API 配方不应绑定 CLI 的清单（2026-11-28 #243 发现，当时改用发布时写入打包清单绕开）

本地复现发现的旧准入缺口（不再按旧设计修，记录备查）：批次须含 CLI/client；收集器不认 `.raw.json`/`.canonical.json` 元数据文件名；CLI 的 `package.json`、`bun.lock` 等 4 个文件未登记。

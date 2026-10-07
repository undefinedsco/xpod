# 桌面公共组件消费方收尾

## 清理范围与分层

2026-10-05 源码复核发现已有公共原语仍有消费方遗漏。先复用现有实现，不增加依赖或平行组件：

1. 宿主侧栏 attention 点与通知按钮角标改用 `StatusDot`。导航、通知数量、开关与焦点恢复仍由宿主管理。
2. `ListSurface` 增加与已有 `ListRow` 一致的 `asChild` 组合入口。AI 密钥列表保持真实 `ul/li`；凭据拖动容器保持同一个 `div` 与 ref，不添加 DOM 包装。容器的共用圆角/描边来自 shared-ui，分隔线与业务行保留现有行为。
3. 凭据排序手柄复用 `interactiveFocusClass`，不另写 focus ring。排序算法与事件处理不改。
4. `PodBody` 的模型分组标题与 `AiCredentialPoolSection` 的“当前连接 + 动作”标题复用已有 `SectionHeader`。保留 h2/h3 层级、现有字号/色彩与全部授权动作。模型目录头含同行统计/live 状态、服务商实体头含 Avatar/链接、offering 头含 `aria-labelledby` 的 h4 id，这些组合已有 applet 内组件，不强行改成不同 DOM 的通用标题。

shared-ui 只负责展示与原生元素组合；extension-sdk 继续负责布局/宿主协议；applet 保留凭据、密钥、排序等业务。登录内部专用结构、导航整体、网络能力正文以及尚无真实消费者的选择卡不在本次搬迁范围。

## 验证顺序

- 改动前运行现有状态点、列表、AI 密钥与拖动、宿主布局与通知交互测试，锁定行为。
- 为新增的列表组合入口先补行为回归：保留 `ul/li` 与 accessible name、无额外包装、ref/事件转发到真实元素；先记录失败，再实现。
- 改动后重跑受影响包与 UI 测试，并执行类型检查、相关 lint 与构建。单元测试不能代替浏览器尺寸/视觉验收或真实 Xpod 验收。
- 提交前仍须通过完整 `bun run test:integration`。本次不把历史通过记录当作当前代码通过，也不触碰其他分支问题。

## 交付证据

受控真实浏览器首轮复验发现：`SectionHeader` 的动作槽 `shrink-0` 让 AI 的四个授权/额度按钮以整行宽度撑出窄窗（390/320、100/200% 字号、深浅主题，共 8 个维度失败）。在公共动作槽增加可收缩与父宽约束，使内层 flex-wrap 有真实宽度约束；不以页面隐藏溢出修复。修复前 verdict 与截图保留于 `.test-data/opencode-shared/consumer-qa/`。

执行结果与尚未完成的门禁在验证后补充。临时日志统一存于 `.test-data/opencode-shared/`，不得提交凭据或原始 worker 日志。

### 已完成的受影响验证

- OpenCode Go A（`opencode-go/deepseek-v4.1-flash`，进程级 A key 注入，未改全局认证）完成两路消费者修改及公共标题窄窗修复；实际 CLI 均退出 0，无 429。原生 DeepSeek agent 因 ChatGPT 账号不支持该模型而未能启动，不计为已执行的 worker。
- 列表 `asChild` 新行为回归：实现前 2 失败 / 4 通过，实现后 6 通过。原生列表直系 li、子 ref、surface ref 和指针事件转发均有行为断言。
- shared-ui 与 ai-connections 全包：56 文件 / 671 测试通过；受影响宿主导航、抽屉、通知、Pod、设备：6 文件 / 26 测试通过。两组互不重叠。旧授权按钮测试依赖 h3 的直接父 div，改为检查既有动作组及 h3 层级，保留新建/导入/错误/disabled 的全部断言。
- shared-ui / ai-connections / pod-settings 构建、root `build:ts`、`typecheck:test`、相关源码 lint 通过；UI app/dashboard/settings 构建通过。
- 新受控浏览器直接挂载生产组件：1280/390/320 × 深浅主题 × 100/200% 文字，共 12 组均无横向溢出，真实 ul/li 保留。方向键排序后顺序改变、焦点仍在原手柄；焦点为单个 2px outline，box-shadow 为 none；无 pageerror。首轮 8 组溢出失败的 verdict 保留，修复后 verdict 也写入 `.omx/state/shared-ui-consumer-cleanup/ralph-progress.json`。
- 浏览器样例的排序回调必须像真实持久化那样重写 priority；仅换数组顺序会被生产组件按原 priority 排回。已修正测试夹具，未改变产品排序算法。

### Consent 与剩余边界

已登录进入授权、授权过程中先登录后继续，是两个入口，均落在 `ui/src/pages/ConsentPage.tsx` 并消费 shared-ui 的 `ConsentView`。`ui/src/auth/WebAccountViews.tsx` 仍定义旧 `WebAccountConsentView`，当前无产品调用（只有自身测试）；本次未改变认证流程或删除旧视图。

完整集成准备时新建了独立的 K8s 临时 PG/pgvector、Redis、S3（run `xd-ui-1005-99a098`）。私有编排脚本最初把 kubectl 的多份 JSON 输出误当作一个 List，已按本次 run/owner 查询实际创建资源并记录 UID；没有遗漏资源继续运行。恢复时本机可用空间已跌到 2 GiB 启动余量以下，之后仅约 593 MiB，因此未启动完整集成命令。7 个资源均核对 UID/owner 后删除，远端复查剩余 0，端口转发未启动；无 PVC/VM 或生产/RC 数据修改。这是未完成的门禁，不是集成通过。

本文件的组件测试/受控浏览器证据不替代完整集成、正式桌面更新、真实账号/Pod 或 Chat 验收。计划 §4 的有意保留/暂缓项继续有效，不宣称整个前端所有组件已清理完毕。

### 集群成本约束（用户后续修正）

上述两轮临时基础设施曾使用 `cloud.sealos.io` / `ns-1yl0rye9`（SG），并非广州。用户指出 SG 成本高后，后续测试固定广州 `gzg.sealos.run` / `ns-iknkxtc8`，禁止因连接失败自动回退 SG；私有编排脚本已同步锁定广州配置与 namespace，且拒绝跨集群恢复旧 run。SG 本任务 owner 标签下的 Pod/Service/ConfigMap 已再次只读复查为 0。广州下载配置当前报 `unknown certificate authority`，系统 CA + hostname 校验也未通过；未禁用 TLS 验证，未发送凭据到未验证的服务端。

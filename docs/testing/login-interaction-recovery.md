# 登录交互失败恢复设计与验收

保留现有主重试；次操作必须有明确去向，不使用浏览器后退，不重放 callback code/state。

| 场景 | 次操作 | 身份与交易约束 |
| --- | --- | --- |
| WebID 登录失败/过期 | 返回登录，复用 cancel | 取消当前交易，持久化手动进入意图，不自动重入 |
| 已认证但 Pod 失败 | 切换账号，复用产品退出协调器 | 普通重试保留 WebID；显式切换才退出；退出失败继续阻挡 |
| Callback 失败 | 返回应用 | 安全 returnTo；取消本次交易及回调缓存，保留有效会话，不再次兑换 code |
| Account controls 失败 | 桌面有 cancelLogin 时返回应用；浏览器保留重试 | 复用 DesktopLoginReturnAction，仅调用可信宿主出口；拒绝后可重试，不猜测公共 URL |

采用先补失败回归、再接入现有动作、最后验证类型和真实交互的顺序。

## Consent 与桌面恢复

先用既有 ConsentRetry/ConsentResume 测试锁定四个缺口，再修改同一页面和已有 FailureView，避免另建认证状态来源。

- 手动提交失败：重试先读取当前 interaction；返回授权恢复表单，保留选择和记住应用选项，不自动再次提交。
- 多选恢复先锁定回归，再区分进入页面时应用限定的绑定与用户在表单中的选择：重试继续校验服务器最新候选，保留仍有效的选择；不得把失败提交暂存的选择变成新的范围限制。
- 自动恢复失败：显式重试允许原受约束恢复；返回授权抑制自动恢复，等待用户确认。
- 取消失败：重试只执行取消；成功才跟随真实 IdP 地址。错误页保留取消和换账号入口。
- 取消成功后保留本地交易到 callback，先读取原始路径与查询参数，再清理；不得在 IdP 页面提前删除应用的 `returnTo`。
- 交互已失效：识别真实 H400/E0002 响应，不重复旧请求、不推测客户端回调。浏览器返回本 IdP 账号入口；桌面通过无参数且校验来源的 IPC 返回配置的应用入口。
- 桌面返回只表示本机放弃当前登录，不声称远端 IdP 已取消；复用既有 cancelled 意图防止自动重入。

使用真实浏览器的正常请求与明确的单次故障注入验证；另用真实 Electron 检查恢复按钮与返回后的页面，并保留截图、路由和会话证据。

### 操作矩阵

| 失败阶段 | 重试 | 返回与退出 | 必须保持的状态 |
| --- | --- | --- | --- |
| 授权信息加载失败 | 重新 GET 当前 interaction | 取消授权；桌面返回应用，浏览器返回本 IdP 账号入口 | 不自动批准、不创建 WebID 会话 |
| 手动选择 WebID / 批准失败 | 先刷新，等待用户再次批准 | 返回授权、重新选择、取消授权、换账号 | 保留记住应用和仍有效的选择；应用预先限定的绑定不得扩张 |
| 已记住授权的自动恢复失败 | 显式重试原受限恢复 | 返回授权改为手动；取消或返回应用 | 返回动作不触发自动 POST |
| 取消授权失败 | 只重试取消 | 有效会话可返回授权；安全返回 | 不调用批准、选择或 token 接口 |
| Account 会话过期、interaction 仍有效 | 刷新 Account 状态 | 保留 interaction 路径重新登录；允许取消 | 不把 Account 登录当成 WebID 认证 |
| interaction 失效（H400 / E0002） | 禁止重放旧请求 | 仅安全返回，由应用重新发起 | 不从不可信参数猜测回调地址 |
| 桌面返回接口失败 | 重试返回 | 原页面仍显示失败；请求中禁用重复点击 | 不把本地返回误报为远端取消 |
| Callback 失败 | 原有重新登录动作 | 返回本次应用入口 | 清理已关联交易和回调缓存，不重放 code；返回动作保留有效 WebID |
| Account 服务不可达 | 重试服务发现 | 桌面可返回应用 | 浏览器无已验证出口时不制造循环跳转 |

本表补充[原登录状态矩阵](login-state-matrix.md)与[部署覆盖证据](login-coverage-and-modularity.md)。三种部署共用这些 UI；部署矩阵结果与本次故障注入结果分别计数，不能将一个部署的负例通过写成所有部署均逐项验证。

### 模块边界与变更位置

| 职责 | 文件 | 本次简化 |
| --- | --- | --- |
| 授权步骤与选择恢复 | `ui/src/pages/ConsentPage.tsx` | 统一失败动作路由；复用原存储选择校验，区分入口限制和可编辑选择 |
| 失效响应分类 | `ui/src/pages/ConsentPage.utils.ts`、`ui/src/auth/xpod-account-copy.ts` | 加载、选择、批准、取消共用同一分类 |
| 通用错误展示 | `ui/src/auth/WebAccountViews.tsx` | 复用 FailureView，统一等待时禁用按钮 |
| Account 桌面出口 | `ui/src/auth/DesktopLoginReturnAction.tsx`、`AccountAuthBoundary.tsx`、`ui/src/components/ErrorScreen.tsx` | 两个错误页共用返回状态与防重复调用 |
| WebID 与回调恢复 | `ui/src/solid/WebIdAuthBoundary.tsx`、`XpodOidcCallbackApp.tsx` | 复用既有取消、退出及回调清理，不新增认证状态来源 |
| 桌面可信返回 | `desktop/src/main.ts`、`preload.cts`、`login-recovery.ts` | 页面按钮复用既有原生取消流程；目标仅来自宿主配置 |
| 桌面窗口尺寸 | `desktop/src/window-mode.ts` | Account 使用 480×640，WebID 使用 280×400；分别校验几何与操作可见性 |
| 回归与真实交互 | ConsentRetry/ConsentResume、Callback/Boundary、DesktopLoginReturnAction、desktop recovery 单元测试及 `tests/e2e/consent-recovery.spec.ts` | 同时断言可恢复和不得发生的额外提交 |

### 失效响应分类收敛

先补取消响应仅含 `E0002` 的失败回归，再把现有响应分类移至 `ConsentPage.utils`，供加载、选择、批准和取消共同使用。保持现有错误回退文案及成功跳转契约，避免取消路径保留第二套失效判断。

## WebID / Callback 定向验证

- 先红：`recovery-red.log`，新增返回动作缺失与按钮数量断言共 3 项失败。
- 修复后：四个现有测试文件合计 77 项通过（`recovery-green.log`），覆盖 WebID 失败退出到手动入口、Pod 明确切换、Callback 放弃不登出有效身份或重放 code。
- UI 生产 TypeScript 检查通过；构建及真实浏览器结果见下表。
- 日志目录：`.test-data/login-audit-20260915/`。

## 本轮验收证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Consent、取消和存储范围恢复 | 51/51；包含固定范围缺失不创建 Pod，以及取消前保留原始 query | `consent-recovery-51-green.log` |
| WebID 边界 | 15/15 | `recovery-green.log` |
| Callback 恢复及稳定 URL 清理 | 52/52 | `callback-associated-green.log` |
| Account 桌面出口 | 17/17 | `account-return-green.log` |
| Desktop IPC 与尺寸单元 | 140/140，构建通过 | 桌面恢复与尺寸日志 |
| 原有认证 / Pod 组合 | 51/51，零重试；覆盖跨 origin、外部 applet、真实 Pod、注册、双标签页、会话过期与离线恢复 | `recovery-auth-regression.log` |
| 最终取消所有权变更 | 2/2；取消一个 interaction 不破坏另一个、拒绝后可重试且异常返回地址被拒绝 | `recovery-final-cancel.log` |
| 失败恢复实机验收 | 7/7，零重试：浏览器两尺寸各重试 / 返回重选 / 取消，以及真实 Electron 返回 | `consent-recovery-verified/report.json` 与截图 |
| 返回后的最终窗口尺寸 | 1/1；显式等待实际 280×400 后截图，PNG 为 560×800（DPR 2） | `consent-electron-size-verified/report.json` 与截图 |
| 三部署最终复验 | 独立重跑浏览器 6/6、真实 Electron 3/3；无跳过，覆盖账号/WebID 尺寸、私有 Pod 与会话恢复 | `.test-data/login-deployment-results-88578/`、`recovery-deployment-matrix-final-retry.log` |
| 后端完整集成，两遍 | 每遍 lite 151 通过 / 6 跳过，full 45/45 | `recovery-integration-final-1.log`、`recovery-integration-final-2.log` |
| 实际 Gateway 3000 错误恢复 | callback 和返回产品均 HTTP 200；token POST、console error、请求失败均 0 | `live-recovery-smoke/report.json` 与前后截图 |

实际 Gateway smoke 使用独立匿名浏览器访问故意缺失交易的错误回调，仅证明当前实例的恢复出口，不冒充真实账号完整登录。本轮不部署公共 Cloud，也不替换用户当前安装的桌面应用。

最终 7 项使用安装版原生 QLever。重试和返回重选各只有一次失败的选择 POST、一次真实确认 POST、一次 token 请求，随后私有 Pod 写入 201 / 读取 200；取消只发一次 cancel，收到真实 `access_denied`，精确保留原路径和 query，token 请求为 0。Electron 返回通过真实 IPC，仍只有一个窗口，远端 cancel 和 token 请求均为 0。

Account 实际内容区域为 480×640，恢复按钮全部可见；返回后 WebID 内容区域恢复为 280×400。最终前后截图在 `consent-electron-size-verified/e2e-consent-recovery-Elect-8cdb0--native-cancellation-bridge-chromium/`。较早的 `consent-recovery-verified` 返回截图拍摄于窗口尺寸收敛前，不能作为最终 WebID 窗口尺寸证据；新增断言等待真实尺寸后才保存截图。

UI 四套产物、最终 Account / Callback 产物、桌面构建、相关 UI 生产类型检查和定向 ESLint / diff 检查均通过。原审计记录的仓库级 `typecheck:test` 历史类型错误未在本轮重新宣告解决；不能把相关模块的类型检查通过写成整个仓库无类型错误。

失败历史保留：`consent-recovery-final/` 记录取消后原查询参数丢失；`consent-electron-clipped/` 记录 280×400 裁切。修复分别由 callback 接管本地交易清理、Account 独立尺寸解决；后续通过结果不覆盖这些失败证据。

三部署首轮的 Cloud 注册失败另保存在 `.test-data/login-deployment-results-86532/`：页面显示注册失败，同阶段出现 Account 锁 6 秒过期日志，主机负载采样约 155。现有证据未记录具体失败 POST 的响应，不能证明锁过期是直接原因；停止其他本轮大型夹具后，原参数独立重跑 9/9 通过，未调整超时或断言。该偶发注册失败的根因尚未确认。

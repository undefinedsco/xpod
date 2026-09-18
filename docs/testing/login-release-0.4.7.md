# 登录发布 0.4.7 验收记录

## 发布原因与当前状态

0.4.6 的 RC（35310365225）通过，但 stable（35312173244）根 npm 包在发布前被体积门禁拒绝：89,015,501 字节，超过 40 MiB。只有 darwin-arm64 原生包发布到 stable-staging；根包、latest、镜像晋级和生产部署没有完成。已有 v0.4.6 保留，新修复使用 release/0.4.7 重新验收。

本版本完整构建、全量 UI 和仓库外 JS 包消费已通过；两轮完整集成也已通过；RC、稳定发布和线上验收仍待完成。旧 RC 的通过不适用于当前修改。

## 身份约束修正

完整 WebID 字符串是身份键。不得把不同域名大小写、默认端口、路径点段、query 或 fragment 写法经 URL 规范化合并。Pod 查找、Account 绑定、所有权、角色、provision receipt 与链接复用、授权选择、记忆记录和登录事务按该约束处理。URL 校验与 storage/issuer 地址规范化保持不同职责。

旧 KV 索引只能在没有显式 Pod 身份时提供历史兼容。索引与显式身份冲突不能覆盖 owner。

## npm 包边界修正

- 在打包临时目录筛选编译 source map 和 tsbuildinfo；保留 JS、类型声明、许可证与普通 .map 资源，覆盖直接依赖和嵌套依赖。
- ai-connections 和 shared-ui 共用 lucide-react ^0.525.0，避免因两种版本把整套图标库重复嵌入。保留全部 workspace 公共 exports。
- 实际打包回归检查公共入口和依赖清单，不能只凭目录名称删除 UI 或 SDK 内容。
- 完整构建后实测压缩 11,082,630 字节、解包 48,878,317 字节；旧清单解包 89,015,420 字节。剔除重复图标与编译诊断后减少约 40.1 MB。
- 实测剩余主要内容：静态页面 20,326,477 字节、drizzle-solid 9,111,801 字节、根 dist 7,990,491 字节、补丁版 CSS 4,282,270 字节；保留公共声明及入口。登录回调与设置页面各自包含已验收的同文档恢复及 Pod 查询代码，不能删除被引用的 chunk 来凑门限。
- 解包预算从 40 MiB 改为 48 MiB（50,331,648 字节），覆盖上述合法运行内容，余量约 1.39 MiB；压缩预算保持 20 MiB。新增门限边界测试证明超过一个字节也会被拒绝。门禁继续禁止原生产物、编译 source map 和构建缓存。

## 已取得的证据与范围

- 前端：两树各 90 项定向测试通过；原树 UI 类型检查通过。候选依赖 force 重装后曾因跳过 postinstall 丢失 Inrupt transport 补丁而出现类型错误；通过正规 postinstall 链恢复后类型检查通过，新增 checker 检测缺失声明及 CJS/ESM fetch hook，避免误报通过。
- 后端：原树 133、候选 119 项定向测试通过，限定入口类型检查通过。第一轮完整集成的 Lite 为 151 通过、6 跳过；Full 在启动前被 Docker 镜像 TLS 拉取超时阻断，未开测，不能记完整通过。
- 打包：4 文件 15 项通过，1 项原有 opt-in 测试跳过；新测试先红后绿。
- 图标组件：首次 336 通过、1 项 adapter 超时；同阈值复验 adapter 45/45 通过。此结果不替代最终完整构建或消费安装。

当前证据见候选 .test-data/release-0.4.7/ 和原树 .test-data/login-audit-20260915/release-preparation/webid-*、workspace-icons-*。

## 完整构建后的复验

- 完整 build：工作区包、根 TypeScript、Components、四套 UI 构建退出 0。
- 全量 UI：84 文件、744/744 通过；修正 3 个旧测试文件的四项旧契约断言，保留 Account 独立尺寸与 API Key 创建时一次性返回、列表不返回原文的现有产品行为。修改 UI 生产文件的 ESLint 通过。
- npm 产物：实际 pack.json 通过 48 MiB 解包 / 20 MiB 压缩门禁。打包边界回归 15 通过、1 原有 opt-in 跳过；预算专项 5/5。
- 仓库外新目录安装：Bun 1.3.12 安装后认证探针通过，同一安装闭包的 Node 24.20.0 探针也通过。探针包含 scoped interaction、refresh、remembered cookie、callback cleanup 与历史 credential 查询兼容。本地 tgz 烟测明确移除了原生 optional dependency，不能用它声称注册表原生安装、桌面或生产实例通过。
- 镜像恢复后第一轮完整集成退出 0：Lite 151 通过/6 跳过，Full 45/45；第二轮也退出 0：Lite 151 通过/6 跳过、Full 45/45。自有容器和卷已清理，未触碰实际 Local 服务。
- 原 Docker Hub MinIO 地址返回 401；集成 overlay 改用官方 Quay 多架构 index `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`，对应 `RELEASE.2025-09-07T16-13-09Z`。来源为 [MinIO 官方 Docker 指南](https://github.com/minio/minio/blob/master/docs/docker/README.md)。仅测试配置变更，生产 compose 不变；本机通过 OCI 导入保留真实 RepoDigest。
- 未把 Lite、mock 或本地包探针冒充真实线上验收。

## 发布前检查顺序

RC 的必需 desktop job 在完整 runtime 构建后检查根 npm tarball；stable 则在任何 native/root 发布动作前再次检查同一包边界。root pack 失败必须阻止首次上传，不能仅依赖上传 native 后的 root 发布步骤发现体积错误。两处都包含平台 optional dependency 声明，仍由包边界检查拒绝真实 native 二进制混入根包。

提前发布门禁新增两项测试先红后绿；最终 workflow、candidate、包策略及依赖检查合计 56/56。包括原生 optional 声明的实际 preflight 包为 48,878,398 字节，门禁通过。

## RC 后发现的 RDF 模板缺口

RC 35354911147（source `4a61a972dadb5701157fed09b0744bbc53cf6a91`）已通过，但独立协议补测发现 CSS 的 Handlebars 模板会把 WebID query 中的 `=`/`&` HTML 转义，改变 Profile 主体与 ACL/ACR agent。此 RC 不晋级稳定版；修复后必须新建提交并重新通过完整集成和 RC。

修复使用等位替换的 `RdfHandlebarsTemplateEngine`，仅处理 CSS 的五个受控 RDF 模板；校验 IRIREF 禁字符后保留原文，其他 HTML/Markdown/EJS 行为不变。真实 Provider、选择/归属、签名 token 与 HTTP Profile RDF 的组合回归及模板单元合计 59/59 已通过；后续构建与整体验收另记，不能由此推断已经发布。

真实浏览器短 TTL 补测两项分别通过：30 秒 Access Token 自动刷新后越过原到期时间读取私有 Pod；5 秒 Refresh Token 失效返回真实 invalid_grant 后，通过产品完成重新登录并读取同一私有资源。匿名读取均被拒绝，不模拟时钟/网络响应/token。该测试已纳入 `test:integration:auth`，需真实原生 QLever；证据是隔离 Local，不能冒充实际部署。

补充缺失 WebID 拒绝用例后，候选模板/协议/发布文档回归合计 65/65；完整构建退出 0。包括原生 optional 声明的 npm 包压缩 11,084,031、解包 48,885,003 字节，门禁通过。两轮完整集成及新的 RC 仍待完成。

RDF 修复后两轮完整集成均退出 0：每轮 Lite 151 通过/6 跳过，Full 45/45；cloud/local/standalone 及双 Cloud 配置成功加载，自有资源已清理。Full 使用仓库既有 fake QLever fixture，不替代原生运行时验收。另在新构建上以真实原生 QLever 重跑 Browser SDK 两项 TTL 场景，2/2 通过（1.4 分钟、无重试），无残留进程或数据目录。新 source RC、稳定发布和实际实例验收仍未完成。

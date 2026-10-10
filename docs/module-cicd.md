# 模块 CI/CD

本流程落实 [模块分发规范](module-distribution.md)，CI/CD 由开发加速任务统一维护，模块任务提供代码、产物与真实验收契约。

## 检查路由

`module-ci.cjs` 为唯一改动分类入口。根 CI 不再无条件跑服务矩阵：独立 CLI 宿主/模块管理变更只调用复用的 CLI package workflow，使用最小构建 lock，分别在 Linux/macOS 验证 Bun/Node 和清洁 tarball 安装。共享认证客户端、client 接口、CLI 构建器仍被过渡服务消费，这些变更必须继续跑服务类型/单元/集成/运行时/打包矩阵，不能把整个 CLI 目录当作无服务影响。根 lock、未知路径和无法取得差异时保守执行完整服务门禁。文档通常只执行流水线契约检查；发布规范和 AGENTS 变更仍保留服务检查。

每次 CI 都执行 Node 流水线契约测试。`required` 汇总检查选中门禁必须成功，失败、取消或意外跳过都不能通过。仓库分支保护应将 `required` 纳入必需检查；本次代码变更不修改 GitHub 管理端保护设置。

候选发布在触发层排除有限的 CLI-only 文件，避免这些提交进入共享 RC 队列；触发列表由 `node scripts/module-ci.cjs sync` 从唯一 CLI_ONLY 声明生成，契约测试校验不得漂移。进入候选 workflow 后仍重新分类，非服务影响不能解析 RC 元数据、构建镜像、部署或运行共享 RC cleanup。整体服务的独占队列、staging 来源、不可变 SHA/digest 和验收规则保留。共享客户端和宿主变更仍触发服务候选，不能为了节省检查隐藏真实依赖。

## 独立发布

`module-release.yml` 只响应 cli-v/afs-v/api-v/css-v tag，不响应整体服务 v tag。检查 tag 与 package 版本一致、源码 SHA 属于 staging，并按模块串行执行；不安装根服务依赖、不构建服务镜像、不部署共享 RC。

CLI 先运行同一隔离构建/消费者门禁，再检查 `packages/xpod-cli/licenses/release-review.json`。这个文件由既有分发审核完成后填写：schemaVersion=1、status=verified、module=cli、version，以及 contentSha256。摘要由 `module-release.cjs` 对 package.json、LICENSE、README 和 dist 的完整路径/文件摘要/权限库存计算；审核文件不在被审核产物中，因此不会自引用。

审核还必须提供 licenses、source、gateway 三类 verified evidence，每项记录仓库内普通文件的相对 path 和 sha256。路径不能越出仓库，证据与产物变更会使审核失败。生成通知的 partial-collection 状态不等于审核通过；没有审核文件时脚本失败并给出候选内容摘要，不能跳过检查发布。既有真实 Gateway 验收与分发审核要求继续适用，fixture 的成功不能冒充它们。

通过后上传 tarball 与绑定 sourceSha/模块/版本/内容摘要/归档摘要的 release.json。发布 job 仅下载同一 run 的产物，复核绑定再禁用 lifecycle 脚本发布至 npm；预览版本使用 next，稳定版本使用 latest。不重新构建已验证 tarball，不覆盖已存在的版本。这里只实现流程，不创建 tag、不实际发布本轮候选。

AFS/API/CSS 的平台产物目前尚未交付，对应 tag 会在任何安装或发布前明确报 module_artifact_not_ready。后续模块任务交付真实平台包、完整库存/通知和功能验收后，由本任务接入这一公共发布入口；不得用服务整包、脚本占位或缺少 helper 的包冒充模块。

## 验证命令

- `node --test tests/scripts/module-ci.node-test.cjs tests/scripts/module-release.node-test.cjs`
- `node scripts/check-cli-package.cjs`
- 根流水线/发布契约测试、类型检查与完整集成回归。

本地验证只说明代码和隔离测试栈通过；GitHub 平台检查、实际模块发布及当前 Gateway 功能验收分别报告。

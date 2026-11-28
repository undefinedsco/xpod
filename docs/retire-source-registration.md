# 退役逐文件源码登记

2026-11-28 用户决定（方案 1）：服务与模块一起退役“已审源码代际逐文件登记”。本文是动手前的删改清单，范围、保留项和验收以此为准。

## 1 为什么

- 实测：只给几个模块构建文件加一行注释、给 CLI/client 的 `package.json` 加一个字段，就有 81 个测试文件变红（10 个 vitest、71 个 Bun），其中约 45 个是服务镜像 QLever SDK 的源码代际登记——服务的“当前规范源码集合”包含模块文件与 CLI/client 清单，两者在根上焊在一起。
- 成本：pi 升级为改依赖做了一轮登记（一个提交 76 个文件）；2026-10-01 以来 staging 约三分之一的提交在改准入目录。

## 2 替代依据

`staging` 受 PR 审查与必需检查保护。一个产物由本仓库指定工作流在 `staging` 的某个提交上产出，就说明该提交的工作流与源码已经过审查。因此来源校验只核对身份事实，不再核对“文件哈希是否在登记清单里”。

## 3 保留

| 项 | 说明 |
|---|---|
| 来源身份校验 | `github-origin.ts` 的 `observeGitHubOrigin`：仓库、工作流路径、事件、`staging` 分支、运行号与尝试号、提交 SHA、产物名与 digest、作业状态 |
| 服务 RC 的真实验收 | QLever 原生一致性、Private17、部署与用户流、三模式验收、桌面构建与验收 |
| 镜像与产物摘要 | RC 接受的镜像 digest、stable tag 绑定已验收的 staging SHA（`docs/RELEASE.md`） |
| 模块发布 v2 | 包检查、安装验收、npm provenance 与回读（`docs/module-publication-v2.md`） |
| 冻结的已发布历史 | 已发布版本的证据不改写；只在确认无读取方后整体删除 |

## 4 修改

| 位置 | 修改 |
|---|---|
| `github-origin.ts` `observeGitHubOrigin` | 去掉三处登记比对：工作流哈希须在 `reviewedWorkflowVersions`；`stagingPushWorkflowSha256(s)`；`sourceBindings` / `sourceBindingGroups` 的逐文件哈希。保留全部身份事实检查。源码组还携带作业契约（作业名、前置作业、SDK 外层执行器授权），所以不删组：已登记的历史树仍按哈希选中自己的组，其余一律用最新（当前）组的契约；登记文件在新提交上不存在时跳过 |
| 来源策略表（`github-origin.ts`、`qlever-sdk-origin-policy.ts`） | 暂保留：数据仍用于给历史运行选组与提供作业契约，不再阻断新改动。整体删除放到旧模块发布路径移除之后 |
| `module-source-phases.ts` | 去掉“完整源码配方须与登记一致”（`controlledApiSourceRecipe`）与 producer 哈希白名单（`reviewedModuleProducerSource`）；保留阶段计划与回执的机械校验 |
| `source-rules.ts`、`consumer-observer-policy.ts` | 去掉对登记源码组与 `consumer-execution-current.json` 的比对 |

## 5 删除

| 项 | 说明 |
|---|---|
| 登记数据 | `consumer-execution-current.json`、`consumer-execution-*-snapshot.json`、`*-pre*.json` 等代际快照，及测试夹具中的 `*.original.json` 登记副本。第一轮（本 PR）先删登记测试，数据随后清理 |
| 登记测试 | 第 1 节的 81 个测试文件中只检验“登记/代际/规范集合与实际字节一致”的部分（`*-registration.tiny.test.ts`、`sdk8x-*-binding`、`controller6x/7x`、`refused-caller`、`staging-product-origin` 等）；同时检验行为的测试改写为只测行为 |
| 旧模块发布路径 | `independent-publication.yml`、`independent-publication-wave.yml` 及只服务它们的发布组准入代码（模块改由 `module-release.yml` 发布） |

## 6 步骤

1. 修改来源校验与策略表（第 4 节），跑服务 RC 用到的脚本单测。
2. 删除登记数据与登记测试（第 5 节），全量 `tests/scripts` 通过。
3. 用一次真实的 staging RC 验证：部署、用户流、三模式、桌面全部通过；`release.yml` 中依赖来源校验的步骤（如 `release-gate-evidence`、`package-smoke-install`）正常。
4. 更新文档：`docs/RELEASE.md`、`docs/module-distribution.md` 中关于登记的段落；`CLAUDE.md` 若有相关约定一并更新。

## 7 验收

- 给模块构建文件或 CLI/client 清单做无害修改后，`tests/scripts` 不再因登记变红。
- 一次 staging RC 端到端通过；下一次 stable 发布不需要任何登记。
- 改依赖（`package.json`/`bun.lock`）或升版本不再需要登记提交。

# 模块发布 v2：用标准供应链保证替代逐文件登记

2026-11-28 用户决定（方案 B）。本文定义 CLI、client、API、CSS、AFS 模块的新发布方式，替代 `independent-publication.yml` 及其中央准入。服务 RC 与 stable 发布（`candidate.yml`、`release.yml`）不在本文范围，保持现状，是否同样简化另行决定。

## 1 为什么换

现有中央准入要求产物的每个源码文件哈希都与事先人工登记的“已审源码版本”逐一相符。`package.json`、`bun.lock` 在每次升服务版本、改依赖时都会变化，于是每发一个服务版本，模块发布准入就失效一次，要先做一轮登记。

2026-11-27 的实测：用 staging `c33f7427` 的真实产物以 `prepare` 模式运行 `independent-publication.yml`，依次遇到三个缺口——批次须含 CLI/client；收集器不认 CLI 构建的 `.raw.json`/`.canonical.json` 元数据文件名；CLI 的 `package.json`、`bun.lock` 等 4 个文件未登记。该工作流此前从未运行过，模块包从未发布到 npm。

规模：2026-10-01 以来 staging 的 910 个提交中有 296 个修改 `scripts/lib/independent-admission/`（198 个文件、4.8 MB），`tests/scripts` 另有 628 个文件。

## 2 目标与非目标

目标：

- 模块能随版本常规发布，升服务版本或改依赖不需要人工登记。
- 每个发布的包都能追溯到构建它的 staging 提交和工作流运行。
- 发布前后都有真实的安装验收：装得上、能启动、平台对得上。
- 许可义务照常满足：每个包带完整 NOTICE 与许可证；需要提供源码的组件，其源码可从公开位置获取。

非目标：

- 不改服务 RC、stable 与生产部署流程。
- 不改模块产物契约 v1（`xpodModule` 清单、逐文件摘要/size/mode）与 `ModuleStore` 的下载校验，它们继续是安装端的权威检查。

## 3 新流程

每个模块一条流水线，CLI 与 client 合在一条（CLI 依赖 client 的确切版本）：

1. **构建**：只接受 `staging` 上的提交。在对应平台 runner 上用现有 producer 构建，产物保持契约 v1。
2. **包检查**（发布前，阻断）：
   - 清单：`xpodModule.files` 覆盖除 `package.json` 外的全部文件，摘要/size/mode 与实际一致。
   - 平台：所有 ELF/Mach-O/PE 原生文件都能在目标平台加载；universal Mach-O 须含目标切片。
   - 许可：生成 SBOM（CycloneDX）与 NOTICE；许可证不在允许清单内时阻断。
   - 体积：包大小超过该模块的预算时阻断，预算写在模块目录声明里。
3. **安装验收**（发布前，阻断）：在干净目录用随包 Bun 和 Node 分别安装该 tarball，经 `ModuleStore` 激活并真实启动模块，探测就绪；CLI 额外跑 `xpod --help` 与 `xpod module list`。
4. **发布**：`npm publish --provenance --tag next`。provenance 由 GitHub Actions OIDC 签发，把包绑定到仓库、工作流文件、提交和运行编号，可用 `npm audit signatures` 校验。
5. **发布后验收**（阻断提升）：从 registry 重新下载，核对 SRI 与 provenance 指向本次运行，再按第 3 步装一遍。
6. **提升**：通过后把 dist-tag 改为 `latest`，打 `<模块>-v<版本>` Git tag。失败时停在 `next`，`latest` 不变。

同一模块的四个平台包共用一个版本，全部通过才提升。

## 4 源码与许可材料

- 运行包只带 NOTICE、许可证全文和 SBOM，不再带源码归档（API 现在随包的 `provenance/sourcekits/originals.tgz` 约 207 MB）。
- 需要随二进制提供源码的组件（例如 LGPL 的 libvips），由构建收集其对应源码，作为该模块 GitHub Release 的附件发布；NOTICE 里写明获取地址。
- 自建原生二进制（Inngest、QLever 等）的构建原件同样作为 Release 附件保留，不进运行包。

## 5 保留、冻结与删除

| 现有部分 | 处理 |
|---|---|
| 模块产物契约 v1、`ModuleStore` 下载校验、`module-catalog.ts` | 保留，安装端权威 |
| 平台原生文件检查（`physical-module-native.ts`）、安装验收脚本 | 保留，接入新流程 |
| 各模块 producer（`api-module-producer.py` 等） | 保留构建部分；去掉“源码归档进包”和与逐文件登记相关的输出 |
| `independent-publication.yml`、`independent-publication-wave.yml`、发布组中央准入 | 新流程通过后删除 |
| `scripts/lib/independent-admission/` 中只服务模块发布的部分 | 删除；同时被服务 RC 使用的部分保留，逐项核对后再动 |
| 冻结的历史快照（`consumer-execution-*-snapshot.json` 等） | 不改写；只在确认没有服务路径读取后整体删除 |

## 6 版本与兼容

- 模块独立版本，tag 为 `cli-v`、`api-v`、`css-v`、`afs-v`（沿用 `docs/module-distribution.md`）。
- 兼容关系由 `cliApiVersion` 与模块目录声明表达；`ModuleStore` 拒绝不兼容版本，不静默降级。
- 桌面按需下载时锁定确切版本，首次安装后复用，更新只通过显式安装。

## 7 实施步骤

| 步骤 | 内容 | 依赖 |
|---|---|---|
| S1 | 包检查与安装验收脚本独立成可单独运行的命令（复用现有平台检查与 consumer 脚本） | 无 |
| S2 | 新发布工作流（构建 → 检查 → 验收 → `--provenance` 发布到 `next` → 回读验收 → 提升），先用 CLI/client 跑通 | S1 |
| S3 | API 瘦身：剔除其他平台原生文件；源码归档移出运行包，改为 Release 附件；ACP 适配器移出（等 ACP 线定下安装方式） | pi 升级合入（`package.json`/`bun.lock` 变动） |
| S4 | API、CSS、AFS 接入新工作流，四平台首发到 `next`，验收后提升 | S2、S3 |
| S5 | 桌面去掉 API 预置，改为首次使用时经 `ModuleStore` 下载；RC 与 stable 的桌面构建删去 API 构建步骤 | S4 |
| S6 | 删除旧独立发布工作流与只服务模块发布的准入代码 | S4 稳定运行后 |

## 8 验收

- CLI/client：新工作流从 staging 构建并发布到 `next`，`npm audit signatures` 校验通过，干净目录安装后 `xpod --help` 正常；提升到 `latest`。
- API 四平台：包检查通过（无他平台原生文件、体积在预算内），安装验收中模块真实启动并就绪；发布后回读验收通过。
- 桌面：安装包不含 API 模块；首次使用 API 功能时下载、校验、启动成功；断网时显示明确原因。
- 升一次服务版本（改 `package.json`/`bun.lock`）后，无需任何登记即可再次发布模块。

## 9 待定

- 服务 RC/stable 是否也改用同样的方式：本文不处理，S6 时按核对结果再议。
- 国内用户的下载速度：`ModuleStore` 是否支持配置镜像 registry，或在镜像同步之后再提升 `latest`。
- npm 发布凭据：provenance 需要工作流有 `id-token: write`；`NPM_TOKEN` 的存放位置与发布环境保护在 S2 落实。

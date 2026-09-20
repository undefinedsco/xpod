# 常驻开发 monitor

从仓库根目录启动一次，保存源码后自动更新：

```sh
bun run dev
# 同一个 monitor，附带 Electron 开发壳：
bun run dev:monitor:desktop
# Cloud 配置：
bun run dev:monitor --mode cloud
# 指定已有部署配置和本机监听端口：
bun run dev:monitor --env .env.local --config config/local.json --gateway http://127.0.0.1:3030
```

`dev`、`dev:monitor`、原 `dev:repair` 都调用同一实现。`dev:repair:desktop` 同样保留。monitor 持有 Gateway、CSS、API、Vite 及可选 Electron 的生命周期，不再要求另起 Gateway。端口被已有实例占用时明确报错，不终止未知进程。退出用 Ctrl+C；仅清理本次创建的进程树，保留账号、Pod、配置和桌面开发 profile。

默认使用 `.env.local`、Local 配置、Gateway `127.0.0.1:3000`；`--mode cloud` 默认读取 `.env.cloud`。Standalone 使用 `--config config/standalone.json` 和对应 `--env` 文件。额外 CLI start 参数可放在 `--` 后，例如 `-- --seedConfig config/seed.dev.json`；默认不会植入测试账号或重置数据。

已有桌面 Pod 时，应选择桌面已有的配置文件，例如 macOS：

```sh
bun run dev:monitor:desktop --env "$HOME/Library/Application Support/Xpod/.env"
```

源码运行还需使所选配置中的 `XPOD_QLEVER_LOCAL_RUNTIME_COMMAND` 指向已安装的原生运行程序；本机安装版路径为 `/Applications/Xpod.app/Contents/Resources/runtime/qlever/bin/xpod_qlever_local_runtime`。桌面打包启动时注入的路径不会自动出现在源码启动环境中。

项目 `.env.local` 和桌面用户配置是两个独立 profile，不能假定指向同一数据目录。旧的裸 `bun src/cli/index.ts start` 可能将 Bun 自动 dotenv 与用户配置混合；monitor 使用一个明确 profile，迁入旧实例前应核对 RDF 数据库和数据根目录。没有找到旧 Pod 时先核对路径，不要重新创建或迁移数据。

## 保存后发生什么

| 修改范围 | 自动执行 |
| --- | --- |
| `ui/src`、CSS、页面 HTML | Vite HMR 或页面刷新，无需重启 Gateway |
| `src/`、`config/`、`templates/` | 编译 TypeScript、生成 Components.js 定义；成功后重启完整 Xpod，包括 Gateway 父进程 |
| `packages/`、`patches/`、根 `package.json` / `bun.lock` | 构建共享包和后端，重启 Xpod，并重启 Vite、重新预构建依赖 |
| `desktop/src`、桌面资源与构建配置 | 编译桌面代码，重启开发壳；开发 profile 保留 |
| 所选 env / config 文件 | 重建并重启后端，重新读取文件 |

多次保存合并处理，构建期间的新修改进入下一轮，不并行重启服务。编译失败会打印错误并保留当前运行服务；修正后继续自动构建。服务新版本启动失败或首次构建失败时，monitor 保留监听，下一次修改可重试。后端需要完成构建和启动，不能承诺与前端 HMR 一样零等待。

`dist/`、`static/`、`node_modules/`、`.test-data/`、`.git/` 与 TypeScript build info 是生成产物或运行数据，不反向触发构建。修改 monitor 脚本自身需要重新启动 monitor。安装依赖仍显式使用 `bun install`，monitor 不自动执行安装，也不重新执行依赖 patch 脚本；修改 patch 后先按该补丁的维护流程应用，再由 monitor 重建。

## Origin 与环境

浏览器固定使用 `http://127.0.0.1:5173`，端口不自动漂移，避免 Cookie、OIDC callback、localStorage、DPoP origin 改变。

| 路径 | 开发入口 |
| --- | --- |
| `/.account/login/password/`、`/.account/…`、`/app/` | Account |
| `/settings/pod`、`/ai-connections`、`/ai-config/…` | Settings |
| `/status/overview`、`/network`、`/dashboard/…` | Dashboard |
| `/auth/callback` | OIDC callback |

只将 GET + `Accept: text/html` 的页面导航改写为对应 HTML；JSON / fetch / POST 和 Pod 请求透传真实 Gateway。开发模式不启用 `open` / `apiOpen`，不注入 token 或假会话。

`--gateway` 是本机 HTTP transport，`CSS_BASE_URL` 是规范身份域名；monitor 不用前者覆盖后者。Vite 的内部 transport 键仍为 `XPOD_DEV_GATEWAY_URL`，由 monitor 写入自己的子进程。monitor 启动命令禁止 Bun 自动加载 dotenv，确保 `--env` 文件由每次新启动的 CLI 读取；显式 shell 环境变量仍有优先级。直接运行脚本使用：

```sh
bun --no-env-file scripts/dev-repair.ts --env .env.local
```

Electron 使用 `.test-data/dev-repair/desktop-profile`，与正式桌面 profile 分离。它打开同一 Vite origin。关闭窗口可能只隐藏到托盘，退出整个开发服务仍用 monitor 终端 Ctrl+C。

## 验证边界

monitor 的调度测试、真实 Bun 进程／端口测试与真实 Xpod 验收分别报告。后端回归命令包含部分替身测试，不能把通过数量全部称为“无 mock 集成测试”。分类见 [登录状态矩阵](testing/login-state-matrix.md#测试类型与替身边界)。真实登录、Pod 读写、Gateway 认证和 Chat 是独立验收层级。

### 本机实际验收（2026-09-13）

使用现有桌面 profile、真实 Cloud Account 和原有 Local Pod：OIDC token 200 且 Pod ready；React 修改 546 ms 生效，文档与服务 PID 保持；后端修改约 48 秒完成构建和完整重启；所选 env 修改生效；故意制造 TypeScript 编译错误时旧服务保持，修正后自动恢复；Electron 主进程修改后重启并执行了新增代码。所有临时探针均已移除。

另有 11 项调度／真实子进程测试通过；真实 Pod 模式的 Web 24 项、Electron 1 项、Pod 权限和原生查询 5 项通过。这些结果不包含真实 AI Chat 验收。

最终串行 `bun run test:integration` 通过：lite 149 项、full 45 项，另有 6 项显式跳过。monitor 脚本及测试的 TypeScript 检查通过。

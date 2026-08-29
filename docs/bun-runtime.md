# Bun 优先运行时

## 启动规则

- Bun 启动的服务：Gateway、CSS、API 都复用当前 Bun 可执行文件。
- Node 启动的 JS 分发：检测可用 Bun，优先用 Bun 启动子服务；未安装 Bun 时保留当前 Node 兼容运行时。
- Bun 单文件产物：CSS/API 分别通过 `__internal-css` / `__internal-api` 入口复用自身，不再寻找系统 Node。
- CSS 使用统一内部入口，复用现有 Undici/JWK 的 Bun 兼容处理。
- 单文件打包时，Components.js 根据已发现的包元数据直接加载绝对路径，避免 Bun 编译产物对解压模块的包名解析失败（上游同类报告：https://github.com/oven-sh/bun/issues/27058）。该适配只作用于打包产物，不修改依赖源码或开发运行时。
- 不对任意启动错误自动改用 Node。认证、配置、网络或数据库错误必须暴露真实原因，不能伪装成运行时不兼容。

`node:` 导入是兼容 API 名称，不代表进程是 Node。构建工具的原生 ABI 与服务实际运行时应分别验收；Electron 本身仍使用其内置运行时。

## 验证

```sh
bun run build:ts
bunx vitest run tests/runtime/js-runtime.test.ts tests/runtime/start-command-config.test.ts tests/runtime/css-process.test.ts
bun scripts/smoke-bun-services.ts
bun scripts/build-bun-single.js
bun scripts/smoke-bun-services.ts dist/xpod-bun
bun run test:integration
```

服务冒烟使用独立 `.test-data/bun-services/` 数据目录和受限 PATH，直接启动真实 CLI 并检查 OIDC discovery 与服务状态；不修改正在运行的桌面实例或现网。该冒烟只证明服务启动，不等同于真实 Cloud 绑定或 AI Chat 验收。

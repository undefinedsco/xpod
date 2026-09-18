# 登录发布 0.4.9：真实发布元数据与 Bun 安装

0.4.8 的 RC 21 项检查通过，正式发布的 Node 22/24/25 安装与运行验收通过，但 Bun 三项均在安装阶段失败。因此 npm latest、镜像推广、生产部署、桌面正式发布和 GitHub Release 均未执行。既有标签与 npm 版本保持不可变。

## 已证实的缺口

npm 发布会把 `bundledDependencies` 规范化为 `bundleDependencies`，并为未声明 dependency 的内置包补上 `*`。0.4.8 的 loopback registry 直接返回 tarball 清单，遗漏了真实发布时的处理，导致预检通过而官方 registry 安装失败。

使用官方 0.4.8 元数据与原始 tarball 已复现 Bun 1.3.12 请求 `extensions` 返回 404，以及 `ai-connections@*` 无匹配版本。不能把直接 tarball 安装通过替代包名安装验收，也不能删除 native optional 依赖或把必需私包改为 optional 来规避。

## 修复与验收计划

- 私有/工作区内置包使用包内 `file:./node_modules/<包名>` 依赖，保留全部 bundle 声明；原有公开 patched runtime 精确版本依赖与平台 optional 依赖不变。
- 在实际 npm 规范化元数据下验证 Node 与 Bun 的包名安装、包内 CJS/ESM 导出、认证和 runtime；检查最终解析路径与文件内容。允许已有公开依赖的 metadata 请求，不能要求用户能访问未发布私包。
- registry 夹具通过真实、仅 loopback 的 npm publish 取得元数据，校验上传 tarball 与原文件完全一致。隔离配置，关闭生命周期和 provenance，不向公网发布。
- 修复完成后重建、运行回归、完整集成和新 RC。只有新版本正式发布及实际 Local 双账号在线验收完成，才宣告整个目标完成。

## 本地验证进度

固定 Bun 1.3.12 / Node 24 的完整构建通过；发布相关四个文件 29/29 测试通过；平台版本、脚本语法和 diff 检查通过。三轮完整集成均首次通过：每轮 Lite 151 通过/6 跳过，Full 45/45，测试资源清理完毕。Full 仍使用既有 fake QLever，不替代实际原生和在线实例。

最终 tarball 压缩 11,084,339、解包 48,885,487 字节，预算通过。首轮本地包遗漏平台开关，虽然安装通过但不计为发布验收；已重新打包并增加平台 optional 必须精确匹配根版本的输入门禁。冷/暖缓存真实 registry-spec 安装使用真实 npm publish 产生元数据；Node/Bun 最终冷、暖缓存四格均通过，发布元数据保留精确 `@undefineds.co/xpod-darwin-arm64@0.4.9`。每格检查六个内置包共 2,164 文件的 SHA256 及包内真实路径，防止相同内置包版本的旧缓存误通过。

新 RC、正式发布与实际 Local 在线验收尚未完成；0.4.8 的证据不替代 0.4.9 的最终产物验收。

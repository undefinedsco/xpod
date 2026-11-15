# CSS/API 物理运行依赖闭包

模块的入口、依赖声明与生成产物必须一起验收。工作区内能运行不证明独立模块可用；不得复制整个根 node_modules 作为隔离证据。

共同 producer `scripts/lib/physical-module-stage.ts` 从规范源码的依赖表达式和模块显式 `runtimePackages` 收集依赖，按实际安装的 package identity 递归解析 dependencies、optionalDependencies 与非可选 peerDependencies，保留原始文件、版本和库存。相同源码而传递依赖不同的包不能合并。

TypeScript 与 JavaScript 中间文件都必须被递归检查。JavaScript 保持原来的模块格式和扩展名；检查用的 CommonJS 转换不得覆盖原始 ESM 文件。规范源码的非字面量 require 无法据此得到确定闭包，打包应明确报错。第三方原始运行包仍按照自身 manifest 收集传递依赖，不禁止其合法动态 require。

API 的 native dynamic import 可以不出现在 bundle metafile 中。Pi SDK 的实际加载位于 `src/api/runs/PiAgentRuntimeDriver.ts`，因此 `@mariozechner/pi-coding-agent` 必须进入 API package.json 的 dependencies；现有 stage 从该声明读取 runtimePackages，不能另外维护第二张目录。依赖约束沿用已有 `^0.55.1`，不因此升级已锁版本。Inngest 与 ACP 的原声明和原生材料门禁继续适用。

CSS 持有 QLever 的启动、原生输入与关闭生命周期。CSS 使用 AFS 的协议/存储 adapter 属于合法运行依赖，不能通过删除实际依赖制造隔离；AFS 客户端 helper/native 的分发闭包须另外验收。CLI 不得因下载或启动模块而安装 CSS/API 或 AFS 原生运行载荷。

## 可执行验证

`tests/scripts/physical-module-isolation.test.ts` 使用实际共同 producer，覆盖 TS 经 js/cjs/mjs 引入运行包、非字面量 require 拒绝。`packages/xpod-api/tests/declared-runtime.test.ts` 从实际 API manifest 读取唯一运行依赖入口，验证静态依赖扫描无法发现的 native dynamic import 以及声明的第三方动态 require 传递依赖。

两类用例在独立临时目录生成产物，移走原输入树，然后分别用 Node/Bun 在输入树外执行，清空 NODE_PATH。它们使用受控依赖夹具；不证明真实 Pi SDK、完整 API/CSS 启动、Gateway/OIDC 或 registry 发布已经通过。原有 physical-stage 测试继续覆盖嵌套版本、相同内容的不同依赖图、路径链接与身份覆盖拒绝。

2026-10-13 专项记录：新增五项加原四项，共九项通过；针对复制且逐字节校验的 producer/test 输入进行独立工具链类型检查通过。真实已安装 Pi 0.55.4 的 manifest 闭包审计得到 196 个包身份，必需依赖无缺失、八项可选依赖未安装。该审计没有启动实际 SDK，不能替代实际模块归档的完整库存及独立消费者验收。完整集成回归与发布由开发加速统一执行。

显式 `runtimePackages` 与规范源码的静态导入具有相同的顶层包身份约束。共同 producer 不得因另一版本被更多传递依赖引用就替换声明包；需要另一版本的消费方保留自己的嵌套依赖。专项测试使用 API 实际声明中的 Pi 包名构造两个版本，移走输入目录后，在 Node/Bun 中同时验证动态加载的声明版本和消费方的嵌套版本。这是受控身份测试，不代表真实 Pi 完整模块产物或服务启动通过。

# CSS Components 独立生成入口

## 入口与职责

在仓库中运行 `bun run --cwd packages/xpod-css build:components --out <新的元数据目录>`，可独立生成 CSS Components，无需预先生成根 `dist`。`build:module` 使用相同入口自动生成临时元数据，交给已有 physical stage；其临时目录在成功或失败后都清理。此命令生成构建输入，不启动服务，也不授予运行归档发布资格。

`component-resources.ts` 原有的配置引用、参数关系、同文档组件闭包与规范源码 export 解析继续负责选择和资源适配。冷构建从配置字符串及参数别名引导这套 export 映射，不另维护组件注册表。外部组件仍消费所属包已经构建的声明和 metadata；不会调用 AFS module build 或把 AFS 当作另一个整包 Components 生成目标。

## 声明与协议标识

`scoped-components.ts` 只把选中的规范组件源码作为 TypeScript roots，沿其真实类型/继承导入闭包执行 `emitDeclarationOnly`。它保留原编译配置中的严格检查和 `skipLibCheck` 值，要求 `noEmitOnError`，并始终启用上游生成器的 `hardErrorUnsupported`。所选组件的类型错误必须失败；有真实导入关系的 API 代码不会被隐藏或替换。

声明在独占目录中保持原 `dist/<源码相对路径>.d.ts` 布局。同名临时包的 `types` 指向具名声明适配入口 `dist/.css-components-entry.d.ts`，原包名、版本和 `lsd:*` 字段保留。原 `src/index.ts`、package.json、根 `dist` 均不改写。这个路径布局影响协议：现有组件与参数 IRI 是 `undefineds:dist/...#Class` 和 `undefineds:dist/...#Class_parameter`，不能改成 `dist/components/...`。

真实 `componentsjs-generator` 的 `Generator` 只接收一个 `pathDestination`，不覆写其解析器，不扫描其他包作为生成目标。同源码文档中的公开类和接口一起保留；生成元数据中的本包引用继续扩展同一选择集合，直到稳定。循环以公开导出总数为界，无法稳定时失败。新鲜输出路径必须显式提供，不能覆盖已有生成目录。

生成目录中的 `scoped-components.json` 记录所选导出、每轮实际编译源码 SHA256 和有效严格选项；CSS stage 在 provenance 中保留该记录。生成元数据交给原 planner/materializer 适配为平台包，原 Components 语义和参数 IRI 保留，只有原有 `requireName` 平台适配继续发生。原始源码与生成声明入口是不同材料，不能把生成入口称为原始文件。

## 验证范围

`bun test tests/scoped-components.test.ts` 使用真实 TypeScript 与真实上游 Generator 构造小型 CSS 配置闭包，先移走根 `dist`，再经过实际 producer config 与 materializer。它检查：未选中且无导入关系的 API 源码存在故意类型错误仍可生成；所选组件故意类型错误会阻止生成；同文档类/接口和继承引用保留且闭包稳定；组件/参数 IRI、原 requireName 和登录资源正确。

这些是受控夹具的真实工具链测试，不是实际 Xpod local/cloud 实图、完整 CSS 归档、Gateway 或 QLever 启动验收。实际图若因真实 CSS→API 导入拉入额外源码或报错，必须保留源码列表和具体导入链，按职责修复；不得 stub 类型、删除真实依赖或放宽检查来宣称独立。

## 正常产物窗口与预算

声明/metadata 小夹具不展开原生材料；本地工具链安装约 64 MiB，单次相关测试写入预算低于 256 MiB，测试生成目录自行清理。完整冷构建尚未执行，须先测实际选中源码/导入闭包和 metadata，再决定 CSS stage 预算。完整 stage 会携带实际第三方原始文件、编译器原始文件和 QLever 布局，不承诺低于 512 MiB。

API 正常构建只调用 dashboard/settings，没有调用 UI `build:all` 或根 `build:packages`。历史真实 API collector 的展开估计超过 800 MiB，且可能超过现有 50,000 member 门限；这不证明本次产物大小，不得删除 Pi、原始材料或提高门限制造通过。

CSS 正常 producer 仍需已构建的 AFS adapter 运行包/metadata、与本次源码及 ABI 相符的外部 QLever descriptor，以及 pack 所需原 source/notices/native 材料。历史 ABI7 descriptor 不得替代新候选材料。QLever 构建与生命周期仍由 CSS 持有，AFS 独立命令/native 发布不是 CSS 的构建目标。完整集成回归和当前实际 Gateway 验收仍独立执行。

TypeScript 的全局 declaration-only emit 会因 JSON 没有声明输出而返回 `emitSkipped`，即使所有 TS 声明已生成且没有类型诊断。入口先对完整程序执行原严格诊断，再逐个非声明、非 JSON 的 TS/JS 源文件发射声明，逐项要求 `emitSkipped=false`、无诊断、预期声明路径在 emittedFiles 中且文件实际存在。JSON 不伪造 `.d.ts`，仍参与类型检查并列入源码哈希；运行 stage 仍保留原 JSON 字节。专项同时覆盖 JSON 导入成功、错误的 JSON 派生类型必须失败和实际 runtime stage 的 JSON 字节一致性。

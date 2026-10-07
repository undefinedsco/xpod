# SPARQL.js 数字词法规则在 Bun 下阻塞批量请求

使用当前 Bun 1.3.8、SPARQL.js 3.7.4，真实 ORM 生成的 100 条消息 PATCH 为 420,488 字节。隔离调用公共 `Parser.parse` 耗时 176 秒；同一输入在 Node v23.6.0 下耗时 463 毫秒。服务端 `normalizeGraphs` 再次解析/生成耗时 158 秒。原请求最终超时，不能算作共享文档验收通过。

匹配采样将主要开销定位到三个 DOUBLE、DOUBLE_POSITIVE、DOUBLE_NEGATIVE 词法正则中的 `([0-9])+`。将它改成 `([0-9]+)` 后，匹配语言不变，避免逐个数字重复捕获；生成的 parser action 不读取这些捕获组。隔离 Bun 实例处理原请求降至 56 毫秒，完整 AST 与未修改的 Node 解析结果完全一致。Unicode 转义控制仍耗时 122 秒，不能把根因归于正文里的中文或 emoji。

历史 Bun [正则性能问题](https://github.com/oven-sh/bun/issues/5197) 涉及其他正则与旧版本，只作为背景；本问题依据上述当前本机复现，不能声称两者根因相同。

修复计划：通过仓库现有 [Bun patch 工作流](https://bun.sh/docs/pm/cli/patch) 固定 SPARQL.js 当前版本，只改变三个数字规则。保留现有公共 parser、最长匹配策略、语法与 Bun 产品运行时，不新增依赖或配置。验证 signed/unsigned DOUBLE、指数、decimal、integer、非法数字、变量、IRI、Unicode/转义文本和大型请求的解析语义，再复跑真实 100 条 HTTP 写入、单条更新保持其他 99 条、通知与完整集成测试。

证据在 `.test-data/solid-multiparty-acceptance/provider-b/root-review/`：`root-parser-match-profile.log`、`root-node-parser100.log`、`root-bun-numeric-rules.log`、`numeric-lexer-ast-compare.json`、`literal-normalization-batch100-d3a7f21c-64e9-4979-9fba-1cf72c7d0946-result.json`。该探针只证明解析与 AST 等价；真实 G08/G12 在完整证据通过前仍待验收。

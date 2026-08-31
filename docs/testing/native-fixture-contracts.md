# 原生夹具契约

本规范适用于 QLever、RDF backend、SQLite/PG native adapter，以及测试中动态生成的 C/C++ 头文件、共享库和可执行文件。夹具的职责是尽早暴露生产接口、ABI 和语义不一致；它不是兼容层。

## 接口与 ABI

- 优先直接编译生产头文件。只有生产依赖过重、无法在快速门禁中独立编译时，才允许生成最小头文件夹具。
- 最小夹具必须完整实现被测生产代码实际调用的接口，包括复制/移动语义、返回类型、强类型索引、版本与 capability 字段。不能用同名但签名更宽松的替代接口掩盖问题。
- 生产接口变化时，接口实现、夹具和对应编译测试必须在同一提交中更新。缺少接口应在快速编译门禁失败，不能在产品代码里增加 fallback 来迁就旧夹具。
- ABI 夹具必须使用生产协议头中的 `abi_version`、`struct_size`、字段顺序和函数指针签名。禁止复制一份独立结构定义。

## 行为与语义

- mock 返回成功时必须产生该能力约定的副作用或结果；不允许“无条件成功”的空实现。
- capability 只声明夹具真正实现的能力。声明物理过滤、事务、向量检索等能力后，夹具必须验证请求确实到达对应路径。
- 同一业务值在 native、bridge 和 fallback-free 路径中必须采用相同公开表示。例如向量候选公开稳定的 `retrieval_point_key`，不能有的路径返回内部数字键、有的路径返回解析后的正文。
- 断言优先验证状态、结果、权限、事务和可观察副作用。内部调用次数只有在它本身是性能或安全契约时才做精确断言，避免把冗余调用固化成行为要求。
- 负向用例必须 fail closed：缺字段、缺 capability、列声明不一致、ABI 不兼容或解析失败都不得返回部分成功。

## 分层门禁

接口改动后按以下顺序验证，前一层失败时不进入镜像构建：

1. 运行受影响的单文件编译/行为测试，例如：
   `bun test qlever/tests/QleverCandidateOperationBridge.test.ts qlever/tests/QleverExecutorFactory.test.ts`
2. 运行完整原生契约：`bun test qlever/tests`
3. 运行 Python 构建与交付契约：
   `python3 -m unittest discover -s qlever/tests -p 'test_*.py'`
4. 再进入 TypeScript 全量、integration、immutable image 和集群验收。

完整镜像 conformance 是最终交付证据，不能替代前面的快速夹具门禁。

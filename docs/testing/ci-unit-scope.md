# CI 单元测试范围

`scripts/ci-unit-tests.sh` 决定 CI 里 vitest 单元测试跑哪些文件。目的是缩短 PR 等待时间，但不让任何测试变成可选项。

## 慢测试分组

- 分组成员：`tests/storage/rdf/PostgresRdf*`（进程内 PGlite 上的 RDF 引擎）和 `tests/runtime/XpodRuntime.integration.test.ts`（完整运行时）。按 2026-11 的 CI 日志，它们约占单元测试时间的三分之一。
- `unit` 作业分三个分片并行执行 `ci-unit-tests.sh main <i>/3`（vitest `--shard`），跳过这一组。
- `integration-lite` 作业执行 `ci-unit-tests.sh slow`，只跑这一组，与 `unit` 并行。
- 必需检查 `test` 现在只做汇总：`checks`（原生门禁、类型检查、Node 与 Bun 测试等）和全部 `unit` 分片都成功才通过。`integration-lite` 本身也是必需检查，这组测试失败仍然会挡住合入。
- 新增的测试文件如果单个耗时超过约 20 秒，加入这一组。只改脚本里的列表即可，不改 `vitest.config.ts`：它被历史准入记录写死了哈希。

## 流水线契约测试

`tests/scripts` 是工作流、发布门禁和准入记录的契约测试，约占单元测试时间的四分之一。

- 推送（`staging`、`main`）：全部运行。
- PR 改了流水线、发布或构建相关路径（`.github/`、`scripts/`、`tests/scripts/`、`qlever/`、`docker/`、`desktop/`、`config/`、`patches/`、`packages/`、`Dockerfile`、`package.json`、`bun.lock`）：全部运行。
- 其他 PR：先跑除 `tests/scripts` 以外的单元测试，再用 `vitest --changed <base>` 只跑依赖链碰到改动文件的 `tests/scripts` 测试。这样改了 `src/` 的 PR，仍会跑引用到相关 `src/` 文件的契约测试。

## Bun 专用测试

`bun run test:bun`（`scripts/run-bun-tests.ts`）每个文件仍在独立的 Bun 进程里运行，但默认按 CPU 数并行（`--jobs N` 可覆盖），每个文件的输出在结束时整段打印。并行时子进程的默认超时从 Bun 的 5 秒放宽到 30 秒：默认超时只用于发现挂起，CPU 被其他文件分走时不应把慢但会结束的测试判失败；测试自己写的超时不变。

## 兼容通道

`legacy-root-compat.yml` 在 PR 上只跑 Linux 通道；候选和 `main` 推送仍跑全部通道，并生成发布用的完整回执。Node 只测当前滚动维护的一个 LTS（目前是 24），见 `docs/RELEASE.md`。

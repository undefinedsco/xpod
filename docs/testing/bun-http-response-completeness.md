# Bun HTTP 响应完整性回归

## 问题与版本边界

2026-09-16 的登录验收在 macOS arm64、Bun 1.3.8、系统 Chrome 下发现间歇性页面加载挂起。问题可以出现在 Account、Settings 或 OIDC callback 的 JavaScript 资源，导致页面空白，尚未进入相应认证逻辑。

Chrome netlog 证明失败请求已经发送并收到 HTTP 200，但正文没有收齐。例如 callback 资源声明 `Content-Length: 1980677`，实际收到 `1922364` 字节后等待至测试结束。同一资源此前能完整传输。另一次 Settings 资源声明 `1957014` 字节，仅收到 `1301124` 字节。

隔离实验排除了认证、Pod、磁盘文件和 UI 构建：内存 HTML 与约 2 MB JavaScript 经真实 `GatewayProxy` 传输，在上游响应事件中施加固定 50 ms 消费延迟后，Bun 1.3.8 的浏览器导航仍能复现不完整正文。失败时 Gateway 上游 `IncomingMessage` 未读完；下游 `drain` 已触发，流状态为 `flowing=true`、没有等待 drain，但不再收到后续字节。一次性 `read(0)`、`_read(0)` 和 pause/resume 均不能恢复。

**已验证边界：Bun 1.3.8 失败，Bun 1.3.12 通过。** 这不是对首个修复版本的认定，也不是对所有操作系统的证明。仓库现有 Bun 固定值统一为经过该回归验证的 1.3.12；没有添加 Node fallback、轮询恢复、私有流字段补丁或全局原型修改。

## 官方依据与结论限制

[Bun 1.3.12 官方发布说明](https://bun.com/blog/bun-v1.3.12)记录了就绪 I/O 事件处理、HTTP server cork buffer contention 和关闭 socket 的 drain-loop 等修复。这些说明支持选择更新运行时做对照，但尚未将本问题对应到某一个上游提交。

Bun 1.3.8 的 HTTP client 将响应交给 `IncomingMessage` 的 FetchResponse 路径，内部通过 `reader.readMany()` 消费 body；它与 server IncomingMessage 的 native handle resume 分支不同。诊断中将 readMany 替换成标准 read 的私有进程对照也通过过 100 次，但未证明 readMany 是唯一根因，不将该实验补丁带入产品。

## 持久回归

- `tests/e2e/proxy-response-completeness.spec.ts`
- `tests/helpers/proxyResponseFixture.ts`

测试启动独立 Bun 进程，使用真实 Gateway 和内存上游；连续创建 64 个浏览器 context，保持缓存禁用、5 秒单次导航截止和零重试。每次同时检查实际正文长度、SHA-256 与脚本末尾执行标记。失败保留 trace；`completed-transfers.json` 记录运行时版本与完成次数。无论通过或失败都清理浏览器 context 和专属 fixture。

```sh
XPOD_PLAYWRIGHT_SYSTEM_CHROME=1 bun x playwright test \
  tests/e2e/proxy-response-completeness.spec.ts \
  --project chromium --workers 1
```

`XPOD_TEST_BUN` 仅为该测试选择独立 fixture 的可执行文件，可用于官方版本之间的对照；不改变全局 Bun，也不是产品运行配置。

## 本次证据

私有诊断目录：`.test-data/login-audit-20260915/transport-diagnostic/`。

- `first-run/sanitized-body-evidence.json`：Chrome 正文长度与截断时间线，已去除请求凭据。
- `reproduce-browser-paths.log`、`reproduce-browser-recovery.log`：Bun 1.3.8 的隔离失败与一次性恢复诊断。
- `reproduce-bun-1.3.12.log`：无实验补丁的 Bun 1.3.12，100 次隔离导航完成。
- `e2e-1.3.8.log`：同一正式回归在 Bun 1.3.8 失败。
- `e2e-final-1.3.12.log`：最终正式回归在 Bun 1.3.12 完成 64 次、1 项通过（38.3 秒），持久 JSON 记录版本与完成次数。

这些局部回归不能替代 Account、WebID、Pod 及实际 Gateway 的最终整体登录验收。

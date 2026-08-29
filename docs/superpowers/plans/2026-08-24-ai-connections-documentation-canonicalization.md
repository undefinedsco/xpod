# AI Connections 文档收口计划

> Status: complete
>
> Date: 2026-08-24
>
> Scope: documentation authority and product acceptance order only. This plan
> does not preserve obsolete implementation behavior merely because an older
> document described it.

## Goal

建立一份唯一的 AI Connections 产品规范，并让历史设计、实现计划和验收记录明确降级为证据或内部设计，避免不同版本继续分别驱动产品实现。

## Authority order

1. 用户最新确认的产品决策和可观察的真实产品行为。
2. `docs/ai-connections-product-spec.md` 中的当前产品规范。
3. 当前协议与服务能力的真实实现证据。
4. 自动化与真实环境验收记录。
5. 旧设计、旧实现计划和历史能力盘点。

旧文档与当前规范冲突时，必须以当前规范为准。测试若固化了已放弃的产品路径，应重写测试，不得反向要求产品恢复旧行为。

## Cleanup steps

- [x] 新增 `docs/ai-connections-product-spec.md`，冻结用户任务、信息架构、登录边界、数据对象、宿主职责和验收顺序。
- [x] 为现有 AI Connections 文档添加标准状态说明，并链接到当前规范。
- [x] 将产品矩阵定位为 evidence ledger，而不是需求来源。
- [x] 将 Provider/Offering、caller-owned access 和 service auth 文档定位为内部技术设计。
- [x] 将旧能力盘点和已完成实现计划定位为 historical records。
- [x] 校验所有 Markdown 链接和状态标签。

## Delivery order

实现和验收按以下顺序推进：

1. Web dev server：登录恢复、本机 Pod 绑定、AI Connections 页面、Provider 凭证、模型、Xpod API Keys、`/v1/models`、真实 Chat。
2. Desktop：宿主桥接、客户端配置、后台保活、托盘、关闭与重新打开后的 session 恢复。

Web 链路未通过前，不用桌面壳问题掩盖 Web 产品和数据链路问题。

## Completion criteria

- 只有一份文档标记为 `Canonical product specification`。
- 旧文档顶部能直接判断其当前用途和是否可指导实现。
- Web 和 Desktop 的验收顺序写入规范，且真实验收不会被 hermetic fixture 代替。
- 文档不要求用户理解 WebID、Pod route、Offering、Gateway 或 service access 等内部概念。

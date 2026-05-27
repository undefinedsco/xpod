# 发布流程

## 版本发布步骤

1. **确保在 main 分支**：`git checkout main`
2. **确保代码已合并**：所有待发布的改动已从 api 分支合并到 main
3. **确保测试通过**：单元测试和集成测试全部通过
4. **版本号升级**：使用 npm version 自动升级版本号并创建 tag
   ```bash
   # Patch 版本（bug 修复）：0.1.7 → 0.1.8
   npm version patch -m "🔖 Release v%s

   - 功能点 1
   - 功能点 2"

   # Minor 版本（新功能）：0.1.8 → 0.2.0
   npm version minor -m "🔖 Release v%s

   - 新功能描述"

   # Major 版本（破坏性变更）：0.2.0 → 1.0.0
   npm version major -m "🔖 Release v%s

   - 破坏性变更描述"
   ```
5. **推送到远程**：`git push origin main --tags`
6. **自动构建发布**：GitHub Actions 会自动触发 `.github/workflows/release.yml`，构建 Docker 镜像、先发布平台 Bun 二进制子包、再发布主 npm 包
7. **验证发布**：访问 https://github.com/undefinedsco/xpod/actions 查看构建状态
8. **切回工作分支**：`git checkout api`

## Docker 镜像标签规则

推送 tag 后，GitHub Actions 会自动构建并推送以下标签：

- `ghcr.io/undefinedsco/xpod:0.1.8` - 完整版本号
- `ghcr.io/undefinedsco/xpod:0.1` - major.minor
- `ghcr.io/undefinedsco/xpod:latest` - 最新版本（仅默认分支）
- `ghcr.io/undefinedsco/xpod:sha-xxx` - commit hash

## 语义化版本规范

- **Patch (0.1.x)**：向后兼容的 bug 修复
- **Minor (0.x.0)**：向后兼容的新功能
- **Major (x.0.0)**：破坏性变更

## 注意事项

- 发布前务必确认所有测试通过
- 发布前务必确认 `package.json` 里的平台 `optionalDependencies` 版本与主版本一致（CI 会执行 `yarn check:platform-package-version`）
- 安装/烟测链路默认尊重用户级 `npm` / `bun` registry 配置；也可显式设置 `XPOD_INSTALL_REGISTRY`
- 发布链路默认固定到官方源 `https://registry.npmjs.org`，如确需覆盖请显式设置 `XPOD_PUBLISH_REGISTRY`
- 国内网络下本地安装可先执行 `npm config set registry https://registry.npmmirror.com` 与 `bun pm config set --global registry https://registry.npmmirror.com`
- 提交信息应清晰列出本次发布的主要改动
- 推送 tag 后无法撤回，请谨慎操作
- 如需回滚，创建新的 patch 版本修复问题

## 当前任务进度（2026-04-17）

### 本轮已完成

- `xpod`
  - 当前分支提交：`7688152`（onboarding 连续性、WebID profile storage backfill、本地 dev/test cleanup）
  - 已拣入 `main`：`028a2f9`
  - 已打 tag：`v0.2.17`
  - 已推送 `main` 与 tag
- `homepage`
  - 文案已统一到最新口径：
    - 中文：`你的主理人永不停歇` / `所有碎片合为一体` / `一个主理人，多个智能体`
    - 英文：`Your AI Secretary Never Stops` / `All Your Pieces, In One Place` / `One Secretary, Many Agents`
  - 已打 tag：`v0.1.2`
  - GHCR 与 Sealos 发布已成功

### 本轮验证结果

- `xpod`
  - `bun run build:ts` 通过
  - 相关单测通过：
    - `tests/ui/registration.test.ts`
    - `tests/ui/registration-flow.test.ts`
    - `tests/provision/ProvisionPodCreator.test.ts`
    - `tests/identity/PodLookupRepository.test.ts`
    - `tests/api/handlers/PodManagementHandler.test.ts`
    - `tests/identity/ScopedPickWebIdHandler.test.ts`
    - `tests/storage/QuintStoreSparqlDataAccessor.host-canonicalization.test.ts`
    - `tests/util/MultiDomainIdentifierStrategy.test.ts`
  - `bun run test:integration` 中 lite 路径通过
  - `bun run test:integration:full` 未完成，原因是当前会话下 Docker daemon 不可用，不是测试断言失败
- `homepage`
  - `npm run build` 通过
  - 构建期间存在 CSS minify warning，但未阻塞产物生成和部署

### 当前发布状态

- `xpod`
  - `Release` run `24519327445`：失败
  - `CI` run `24519328480`：失败
  - `Deploy` run `24519574466`：跳过
  - 结论：`v0.2.17` 已推送，但自动发布链路失败，需单独定位 GitHub Actions 失败原因
- `homepage`
  - `CD GHCR` run `24519346077`：成功
  - `CD Sealos` run `24519346122`：成功

### 下一步

- 优先定位 `xpod` 的 `Release` / `CI` 失败原因
- 修复后重新发一个 patch tag
- 确认修复版成功后，再检查 `.co` 环境的实际部署和冒烟链路

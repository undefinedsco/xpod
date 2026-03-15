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
- 提交信息应清晰列出本次发布的主要改动
- 推送 tag 后无法撤回，请谨慎操作
- 如需回滚，创建新的 patch 版本修复问题

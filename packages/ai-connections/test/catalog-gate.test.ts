import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §7.3：已有配置时先呈现已连接对象，全量 Provider 目录只在"添加连接"时出现。
 * 行为测试需要带 providerStates 的控制器，此处先锁住结构契约，避免目录重新变成常驻首屏。
 */
const source = readFileSync(fileURLToPath(new URL('../src/AiConnectionsList.tsx', import.meta.url)), 'utf8');

describe('provider catalogue gate', () => {
  it('keeps the catalogue behind an explicit add action once something is configured', () => {
    expect(source).toContain('const [adding, setAdding] = useState(false)');
    expect(source).toContain('const showCatalog = adding || configuredProviders.length === 0');
    expect(source).toContain('const shownProviders = showCatalog ? providers : configuredProviders');
    expect(source).toContain('data-testid="ai-add-connection"');
    // 目录渲染的是 shownProviders，而不是全量 providers
    expect(source).toContain('{shownProviders.map((provider) => {');
    expect(source).not.toContain('{providers.map((provider) => {');
  });
});

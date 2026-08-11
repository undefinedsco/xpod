import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('live AI Connections product-matrix runner', () => {
  it('runs every real coding client against both live provider offerings', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-ai-connections.ts'), 'utf8');

    expect(script).toContain("const liveClientModels = ['deepseek-v4-flash', 'kimi-for-coding']");
    expect(script).toMatch(
      /for \(const model of liveClientModels\) \{[\s\S]*await acceptRealClientMatrix\(\{[\s\S]*model,[\s\S]*\}\);[\s\S]*\}/u,
    );
    expect(script).toContain("model: input.model");
    expect(script).toContain('discovery.models.filter((model) => provider.expectedModels.includes(model.id))');
  });
});

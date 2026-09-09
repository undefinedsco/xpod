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

  it('uses a real Xpod API Key instead of a Solid client-credentials wrapper', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-ai-connections.ts'), 'utf8');

    expect(script).toContain('await client.createGatewayKey');
    expect(script).toContain('await client.listGatewayKeys');
    expect(script).toContain('await client.revealGatewayKey');
    expect(script).toContain('await client.deleteGatewayKey');
    expect(script).toContain("step: 'auth'");
    expect(script).toContain("step: 'models'");
    expect(script).toContain("step: 'chat'");
    expect(script).not.toContain('account.clientSecret');
    expect(script).not.toContain('Buffer.from(`${account.clientId}:${account.clientSecret}`)');
  });
});

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

  it('authenticates with the canonical Account-credential wrapper instead of a Gateway key route', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-ai-connections.ts'), 'utf8');

    // An Xpod key is an Account client credential. This runner signs in with a
    // client-credentials grant, so it consumes the credential the real Account
    // API already issued for the acceptance account and applies the canonical
    // `sk-` wrapper the host capability builds (ui/src/auth/account-client-credentials.ts).
    // Creating, listing and revoking through that capability is proven by the
    // browser acceptance and by scripts/accept-live-gateway-login-chat.ts; this
    // runner must not fall back to the removed Gateway key management routes.
    expect(script).toContain("sk-${Buffer.from(`${account.clientId}:${account.clientSecret}`, 'utf8').toString('base64')}");
    expect(script).toContain("step: 'auth'");
    expect(script).toContain("scope: 'entire-pod'");
    expect(script).toContain("step: 'models'");
    expect(script).toContain("step: 'chat'");
    expect(script).not.toContain('/api/ai/gateway/keys');
    expect(script).not.toContain('createGatewayKey');
    expect(script).not.toContain('listGatewayKeys');
    expect(script).not.toContain('deleteGatewayKey');
    expect(script).not.toContain('revealGatewayKey');
    expect(script).not.toContain('updateGatewayKey');
  });
});

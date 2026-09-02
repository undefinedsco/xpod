import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('real running Xpod login-to-chat acceptance runner', () => {
  it('uses distinct short Pod names when modes run concurrently against the same Cloud', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');
    expect(script).toContain('normalizeAcceptanceName(`a-${MODE}-${randomUUID().slice(0, 8)}`)');
    expect(script).not.toContain('normalizeAcceptanceName(`accept-${ACCEPT_ID}`)');
  });

  it('creates and verifies an Xpod Gateway API Key instead of wrapping Solid credentials', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('await client.createGatewayKey');
    expect(script).toContain('await client.listGatewayKeys');
    expect(script).toContain('await client.revealGatewayKey');
    expect(script).toContain('await client.updateGatewayKey');
    expect(script).toContain('enabled: false');
    expect(script).toContain('enabled: true');
    expect(script).toContain('await client.deleteGatewayKey');
    expect(script).not.toContain('function codingClientKey');
    expect(script).not.toContain('Bearer sk- wrapper accepted');
    expect(script).not.toContain('Buffer.from(`${clientId}:${clientSecret}`)');
  });

  it('uses the product Cloud account provisioning path for a Local-managed Pod', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('createCloudAccountPassword');
    expect(script).toContain('prepareLocalProvisionedPod');
    expect(script).toContain('createCloudManagedLocalPod');
    expect(script).toContain('POST Local /provision/pods');
    expect(script).toContain('cloudBaseUrl: identityBaseUrl');
    expect(script).toContain('new ProvisionCodeCodec(options.cloudBaseUrl)');
    expect(script).toContain('body: JSON.stringify({\n      podName: options.username,\n    })');
    expect(script).toContain('provisionCode: options.provisionCode');
    expect(script).toContain('provisionReceipt: options.provisionReceipt');
    expect(script).not.toContain('receipt: body.receipt');
    expect(script).toContain('controls.account.pod');
    expect(script).toContain('controls.account.clientCredentials');
    expect(script).not.toContain('setupAccount(');
    expect(script).not.toContain('provisionLocalPod(');
    expect(script).not.toContain('Authorization: `Bearer ${serviceAccessToken}`');
  });

  it('records provisioning and Solid login failures in the identity acceptance layer', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain("fail('identity', redact(message))");
    expect(script.indexOf("layer('identity', true")).toBeGreaterThan(
      script.indexOf("phase: 'client-credentials-login-complete'"),
    );
  });

  it('pins live acceptance to the selected Local Gateway and RC Pod authority', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('process.env.XPOD_LIVE_GATEWAY_URL');
    expect(script).not.toContain('XPOD_LIVE_EXPECTED_POD_HOST_SUFFIX');
    expect(script).toContain('Local route points at');
    expect(script).toContain('Canonical Pod route must use HTTPS');
    expect(script).toContain('Canonical Pod route is not a Cloud-assigned protocol address');
    expect(script).not.toContain("canonicalPodUrl.origin === new URL(CLOUD_IDP).origin");
    expect(script).toContain('does not match acceptance Cloud');
  });

  it('fails closed when the configured provider file is invalid', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('fileState.present && !fileState.spec');
    expect(script).toContain("fail('aiConnections', `Provider key file is present but invalid:");
  });

  it('does not turn an unsuccessful Provider import into configuration acceptance via existing models', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).not.toContain('using existing selected models');
    expect(script).toContain("layer('chat', false, 'Skipped: no verified provider credential')");
  });

  it('keeps separate evidence for cloud, local, and standalone runs', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('process.env.XPOD_LIVE_MODE');
    expect(script).toContain('live-gateway-login-chat-${MODE}.json');
    expect(script).toContain("MODE === 'local'");
    expect(script).toContain('createHostedPod');
    expect(script).toContain('mode: MODE');
  });

  it('never accepts an unrelated Pod as proof of a Local binding', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).not.toContain('?? candidates[0]');
  });

  it('checks both actual probe requests instead of any earlier Gateway request', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');
    expect(script).toContain('expectedProbeTarget');
    expect(script).toContain("['PUT', 'GET']");
    expect(script).not.toContain('localSolidTargets.find((target) => target.startsWith(GATEWAY))');
  });

  it('is the package live-acceptance entry point rather than an isolated test stack', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['ai-connections:accept:live']).toBe(
      'bun run build:packages && bun scripts/accept-live-gateway-login-chat.ts',
    );
    expect(manifest.scripts?.['ai-connections:accept:isolated']).toBe(
      'bun scripts/accept-live-ai-connections.ts',
    );
  });
});

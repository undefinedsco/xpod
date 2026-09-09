import { readFileSync } from 'node:fs';
import Provider from 'oidc-provider';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(readFileSync('ui/public/xpod-desktop-client.json', 'utf8'));

describe('Xpod Desktop public application identity', () => {
  it('accepts native loopback ports while rejecting other origins and callback paths', async () => {
    const provider = new Provider('https://issuer.example', { clients: [metadata] });
    const client = await provider.Client.find(metadata.client_id);
    expect(client).toBeDefined();
    expect(client!.clientAuthMethod).toBe('none');
    for (const uri of [
      'http://127.0.0.1:61226/auth/callback',
      'http://127.0.0.1:3000/auth/callback',
      'http://[::1]:43100/auth/callback',
      'http://localhost:5173/auth/callback',
    ]) expect(client!.redirectUriAllowed(uri)).toBe(true);
    for (const uri of [
      'https://attacker.example/auth/callback',
      'http://192.168.1.2:3000/auth/callback',
      'http://127.0.0.1:3000/other',
      'http://127.0.0.1:3000/auth/callback?next=https://attacker.example',
    ]) expect(client!.redirectUriAllowed(uri)).toBe(false);
    expect(metadata).not.toHaveProperty('client_secret');
  });
});

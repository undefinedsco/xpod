import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  requireCredentialFile,
  stripCloudRegistrationEnv,
} from '../../scripts/accept-network-tunnel';

describe('accept-network-tunnel candidate environment', () => {
  it('removes every input that would register the candidate with a Cloud', () => {
    const cleaned = stripCloudRegistrationEnv({
      PATH: '/usr/bin',
      HOME: '/Users/example',
      XPOD_CLOUD_API_ENDPOINT: 'https://api.undefineds.co/',
      XPOD_PROVISION_CODE: 'code',
      XPOD_PROVISION_URL: 'https://provision.example/',
      XPOD_NODE_ID: 'local-managed-node',
      XPOD_NODE_TOKEN: 'node-token',
      XPOD_SERVICE_TOKEN: 'service-token',
      XPOD_PUBLIC_URL: 'https://node.example/',
      XPOD_SP_DOMAIN: 'node.example',
      XPOD_GATEWAY_LOCATOR_SECRET: 'secret',
    });

    // Acceptance candidates must stay self-contained: a real Cloud registration would both
    // touch the operator's account and replace the entry under test.
    expect(Object.keys(cleaned).filter((key) => key.startsWith('XPOD_'))).toEqual([]);
    expect(cleaned.PATH).toBe('/usr/bin');
    expect(cleaned.HOME).toBe('/Users/example');
  });
});

describe('accept-network-tunnel credential file', () => {
  it('refuses to run without a credential file instead of reporting legs as unconfigured', () => {
    expect(() => requireCredentialFile(path.join(tmpdir(), 'xpod-accept-missing', '.env.acceptance')))
      .toThrow(/does not exist/u);
  });

  it('accepts an existing credential file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'xpod-accept-env-'));
    const file = path.join(directory, '.env.acceptance');
    writeFileSync(file, 'NGROK_AUTHTOKEN=placeholder\n');
    expect(requireCredentialFile(file)).toBe(file);
  });
});

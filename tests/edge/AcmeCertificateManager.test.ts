import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AcmeCertificateManager } from '../../src/edge/acme/AcmeCertificateManager';

const SAMPLE_CERT = `-----BEGIN CERTIFICATE-----
MIICvjCCAaYCCQCzYZphWIDKfjANBgkqhkiG9w0BAQsFADAhMR8wHQYDVQQDDBZu
b2RlLTEuY2x1c3Rlci5leGFtcGxlMB4XDTI1MTExMTA3MjYwMVoXDTI2MTExMTA3
MjYwMVowITEfMB0GA1UEAwwWbm9kZS0xLmNsdXN0ZXIuZXhhbXBsZTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAMUfvY61jRGXmOUCw/CKMdpfmLkH0tQs
3jmtMDcMHI73hudmJtRLavM+dcdRtlkb24s8QeYa3ZOpKp00/noTaOow2ItKFPiK
nQvEPGfjVShv65X5Tv6X1zcLNxCymRN2YTxfRrm8Niy1q6xsi2woeJjqwUw9ai56
eLUvoyvEtXakv11zY/v6SE6g9+X70J3cNf2+KnpHGrJ/g0hYSorzHHSDC8co+1+9
rQ+5FCDRcswZcLDST9Q1AzJrrTglM6LYUAtXZanTc664E8xRcdLMlmE3NseXBQFh
xc8x+qQ1JBk2si+ZYugjnqyU/ITUI02V7smcP6aM4ySYUtKZWoHStv0CAwEAATAN
BgkqhkiG9w0BAQsFAAOCAQEAMhHoYiNdKhNW8LY1/A0tPRY71bCryfu1QKXJDm+y
xRcUhHGTzTHvi/rE4T0/NaOGYlhQ1VYZ7BX4Q9p13AD3lDxF+n6X40EiaWzSs1+s
yJiI9w0CfzOLMwdt4db+7CBWXq95Bep8kEPLXrSqljG+qgdpWRY462EcRfszgUbR
FthYIl292Sn1BL6yh8snJyEE9KYFVmO6PQjB6vEODuhAZj2Twku1u7T6FyE8eJqN
jn64lJdLOW3uzhbxOETW8kNX6AyotU+E5l/3eeNT0v6w7A1Z0RkOm0Smg8nW8xKf
rfWd+Y8jP9+2OHWWDZb4Y/28T35JgI9qQ18eS3HoX1l0wQ==
-----END CERTIFICATE-----`;

describe('AcmeCertificateManager', () => {
  it('exposes runtime TLS status from the configured certificate file without issuing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-cert-status-'));
    const certPath = path.join(tmpDir, 'tls.crt');
    await fs.writeFile(certPath, SAMPLE_CERT, 'utf8');
    const dnsChallengeHandler = {
      setChallenge: vi.fn(),
      removeChallenge: vi.fn(),
    };

    const manager = new AcmeCertificateManager({
      dnsChallengeHandler,
      email: 'ops@example.com',
      domains: [ 'node-1.cluster.example' ],
      accountKeyPath: path.join(tmpDir, 'account.key'),
      certificateKeyPath: path.join(tmpDir, 'tls.key'),
      certificatePath: certPath,
      renewBeforeDays: 10,
    });

    await expect(manager.readCertificateStatus()).resolves.toMatchObject({
      status: 'valid',
      expiresAt: '2026-11-11T07:26:01.000Z',
      domains: [ 'node-1.cluster.example' ],
    });
    expect(dnsChallengeHandler.setChallenge).not.toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('marks local ACME renewal unavailable when no real domains are configured', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-cert-unavailable-'));
    const manager = new AcmeCertificateManager({
      dnsChallengeHandler: {
        setChallenge: vi.fn(),
        removeChallenge: vi.fn(),
      },
      email: 'ops@example.com',
      domains: [],
      accountKeyPath: path.join(tmpDir, 'account.key'),
      certificateKeyPath: path.join(tmpDir, 'tls.key'),
      certificatePath: path.join(tmpDir, 'tls.crt'),
      renewBeforeDays: 10,
    });

    expect(manager.isAvailable()).toBe(false);
    await expect(manager.renewCertificate()).rejects.toMatchObject({
      statusCode: 503,
      code: 'certificate_renewal_unavailable',
    });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

/**
 * N15: staging used to be in the default failover chain, so a production deployment whose primary
 * CA was down could "succeed" by installing a certificate no client trusts. The defaults now
 * contain no staging CA, and an operator-chosen chain that does is called out in the log.
 */
const acmeMock = vi.hoisted(() => ({
  attempted: [] as string[],
  failures: new Map<string, string>(),
}));

vi.mock('acme-client', () => {
  class Client {
    private readonly directoryUrl: string;

    public constructor(options: { directoryUrl: string }) {
      this.directoryUrl = options.directoryUrl;
      acmeMock.attempted.push(options.directoryUrl);
    }

    public async createAccount(): Promise<void> {
      // The account already exists in these tests.
    }

    public async auto(): Promise<string> {
      const failure = acmeMock.failures.get(this.directoryUrl);
      if (failure) {
        throw new Error(failure);
      }
      return '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----';
    }
  }

  return {
    default: {
      Client,
      // The manager reads the default production directory from the real module, so the mock has
      // to expose the same shape.
      directory: {
        letsencrypt: {
          production: 'https://acme-v02.api.letsencrypt.org/directory',
          staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
        },
      },
      crypto: {
        createCsr: async (): Promise<[ string, string ]> => [ 'mock-private-key', 'mock-csr' ],
        createPrivateKey: async (): Promise<string> => 'mock-account-key',
      },
    },
  };
});

const PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const ZEROSSL = 'https://acme.zerossl.com/v2/DV90';

describe('AcmeCertificateManager CA failover (N15)', () => {
  async function makeManager(options: Partial<ConstructorParameters<typeof AcmeCertificateManager>[0]> = {}) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-ca-policy-'));
    const manager = new AcmeCertificateManager({
      dnsChallengeHandler: { setChallenge: vi.fn(), removeChallenge: vi.fn() },
      email: 'ops@example.com',
      domains: [ 'node-1.cluster.example' ],
      accountKeyPath: path.join(tmpDir, 'account.key'),
      certificateKeyPath: path.join(tmpDir, 'tls.key'),
      certificatePath: path.join(tmpDir, 'tls.crt'),
      propagationDelayMs: 0,
      ...options,
    });
    return { manager, tmpDir };
  }

  beforeEach(() => {
    acmeMock.attempted.length = 0;
    acmeMock.failures.clear();
  });

  it('never reaches staging when the primary production CA fails', async () => {
    acmeMock.failures.set(PRODUCTION, 'primary down');

    const { manager } = await makeManager();

    // The failover CA issues the certificate; staging is not in the chain at all.
    await expect(manager.renewCertificate()).resolves.toMatchObject({ status: 'renewed' });
    expect(acmeMock.attempted).toEqual([ PRODUCTION, ZEROSSL ]);
    expect(acmeMock.attempted.some((url) => url.includes('staging'))).toBe(false);
  });

  it('names every CA it tried when the whole chain fails', async () => {
    acmeMock.failures.set(PRODUCTION, 'primary down');
    acmeMock.failures.set(ZEROSSL, 'zerossl down');

    const { manager } = await makeManager();

    await expect(manager.renewCertificate()).rejects.toThrow(new RegExp(
      `已尝试 2 个：${PRODUCTION.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
      'u',
    ));
    expect(acmeMock.attempted).toEqual([ PRODUCTION, ZEROSSL ]);
  });

  it('uses the production failover CA when the primary is down', async () => {
    acmeMock.failures.set(PRODUCTION, 'primary down');

    const { manager, tmpDir } = await makeManager();

    await expect(manager.renewCertificate()).resolves.toMatchObject({ status: 'renewed' });
    expect(acmeMock.attempted).toEqual([ PRODUCTION, ZEROSSL ]);
    await expect(fs.readFile(path.join(tmpDir, 'tls.crt'), 'utf8')).resolves.toContain('MOCK');
  });

  it('honours a staging CA the operator listed explicitly', async () => {
    acmeMock.failures.set(PRODUCTION, 'primary down');

    const { manager } = await makeManager({ fallbackDirectoryUrls: [ STAGING ] });

    await expect(manager.renewCertificate()).resolves.toMatchObject({ status: 'renewed' });
    expect(acmeMock.attempted).toEqual([ PRODUCTION, STAGING ]);
  });

  it('writes the account key and the certificate key as 0600', async () => {
    const { manager, tmpDir } = await makeManager({ fallbackDirectoryUrls: [] });

    await expect(manager.renewCertificate()).resolves.toMatchObject({ status: 'renewed' });

    // 私钥默认权限是 0644（world-readable）：审计 N18 要求落盘即 0600。
    for (const name of [ 'account.key', 'tls.key' ]) {
      expect((await fs.stat(path.join(tmpDir, name))).mode & 0o777).toBe(0o600);
    }
  });

  it('does not add production failover when the primary is a staging CA', async () => {
    const { manager } = await makeManager({ directoryUrl: STAGING, fallbackDirectoryUrls: [] });

    await expect(manager.renewCertificate()).resolves.toMatchObject({ status: 'renewed' });
    expect(acmeMock.attempted).toEqual([ STAGING ]);
  });
});

/**
 * N15（续期链）：`ensureCertificate()` 只在启动时看一次状态，长期运行的节点此前没有任何
 * 东西驱动续期——证书到期只能靠人手调管理接口。这里验证后台续期真的接上了，而且停得掉。
 */
/**
 * Reads a counter once it stops moving for one scheduler interval.
 *
 * The property under test is "a stopped scheduler schedules nothing new"; a renewal that was
 * already in flight when it was stopped still lands afterwards, and racing the sample against it
 * is a test bug, not a product finding.
 */
async function stableCount(read: () => number, intervalMs: number, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let previous = read();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = read();
    if (current === previous) {
      return current;
    }
    previous = current;
  }
  return read();
}

describe('AcmeCertificateManager auto renewal (N15)', () => {
  beforeEach(() => {
    acmeMock.attempted.length = 0;
    acmeMock.failures.clear();
  });

  it('renews by itself while the certificate is missing, and stops when told to', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-autorenew-'));
    const manager = new AcmeCertificateManager({
      dnsChallengeHandler: { setChallenge: vi.fn(), removeChallenge: vi.fn() },
      email: 'ops@example.com',
      domains: [ 'node-1.cluster.example' ],
      accountKeyPath: path.join(tmpDir, 'account.key'),
      certificateKeyPath: path.join(tmpDir, 'tls.key'),
      certificatePath: path.join(tmpDir, 'tls.crt'),
      propagationDelayMs: 0,
    });

    manager.startAutoRenewal({ intervalMs: 40 });
    try {
      await vi.waitFor(() => expect(acmeMock.attempted.length).toBeGreaterThan(0), { timeout: 3_000 });
    } finally {
      manager.stopAutoRenewal();
    }

    // An attempt the last tick had *already started* is not a new one, so the counter is sampled
    // only once it has stopped moving: sampling it right after `stopAutoRenewal()` counted that
    // in-flight attempt as if the stopped scheduler had scheduled it, which made this test fail
    // under load and pass in isolation.
    const attemptsWhenStopped = await stableCount(() => acmeMock.attempted.length, 40);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(acmeMock.attempted.length).toBe(attemptsWhenStopped);
    expect(manager.getRenewalSchedulerStatus()?.running).toBe(false);
  });

  it('does not double the timer when auto renewal is started twice', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-autorenew-twice-'));
    const manager = new AcmeCertificateManager({
      dnsChallengeHandler: { setChallenge: vi.fn(), removeChallenge: vi.fn() },
      email: 'ops@example.com',
      domains: [ 'node-1.cluster.example' ],
      accountKeyPath: path.join(tmpDir, 'account.key'),
      certificateKeyPath: path.join(tmpDir, 'tls.key'),
      certificatePath: path.join(tmpDir, 'tls.crt'),
      propagationDelayMs: 0,
    });

    manager.startAutoRenewal({ intervalMs: 10_000 });
    manager.startAutoRenewal({ intervalMs: 10_000 });
    await vi.waitFor(() => expect(acmeMock.attempted.length).toBe(1), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(acmeMock.attempted.length).toBe(1);

    manager.stopAutoRenewal();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

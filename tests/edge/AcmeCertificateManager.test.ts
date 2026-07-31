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
});

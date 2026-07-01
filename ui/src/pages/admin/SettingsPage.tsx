/**
 * Settings page - advanced local runtime configuration
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { PendingChangesPanel } from '@/components/admin/PendingChangesPanel';
import { SecretField } from '@/components/admin/SecretField';
import {
  getAdminConfig,
  getPublicIpCheck,
  triggerRestart,
  updateAdminConfig,
  getDdnsStatus,
  type PublicIpCheckResult,
  type DdnsStatus,
} from '@/api/admin';
import { clsx } from 'clsx';

type DeployMode = 'local' | 'standalone';
type TunnelProvider = 'none' | 'ngrok' | 'cloudflare' | 'sakura_frp' | 'frp';
type HttpsMode = 'none' | 'acme' | 'manual';
type PublicIpCheckStatus = 'pass' | 'fail' | 'unknown';
type TunnelProviderFieldSpec = {
  publicEndpointKey: string;
  publicEndpointLabel: string;
  publicEndpointPlaceholder: string;
  credentialKey: string;
  credentialLabel: string;
};

type TunnelProfileDraft = TunnelProviderFieldSpec & {
  id: string;
  provider: Exclude<TunnelProvider, 'none'>;
  label: string;
  publicEndpointUrl: string;
  credentialConfigured: boolean;
  configured: boolean;
};

const ALLOWED_KEYS = [
  'XPOD_DEPLOY_MODE',
  'CSS_ROOT_FILE_PATH',
  'CSS_BASE_URL',
  'XPOD_TUNNEL_PROVIDER',
  'XPOD_TUNNEL_ACTIVE_PROFILE_ID',
  'XPOD_TUNNEL_PROFILES',
  'XPOD_TUNNEL_PUBLIC_URL',
  'CLOUDFLARE_TUNNEL_URL',
  'SAKURA_TUNNEL_URL',
  'CLOUDFLARE_TUNNEL_TOKEN',
  'SAKURA_TUNNEL_TOKEN',
  'NGROK_AUTHTOKEN',
  'NGROK_URL',
  'FRP_TUNNEL_TOKEN',
  'FRP_TUNNEL_URL',
  'XPOD_HTTPS_MODE',
  'XPOD_HTTPS_CERT_PATH',
  'XPOD_HTTPS_KEY_PATH',
  'XPOD_CLOUD_API_ENDPOINT',
  'XPOD_NODE_ID',
  'XPOD_SP_DOMAIN',
  'XPOD_NODE_TOKEN',
  'XPOD_SERVICE_TOKEN',
  'CSS_PORT',
  'CSS_SPARQL_ENDPOINT',
  'CSS_IDENTITY_DB_URL',
  'CSS_LOGGING_LEVEL',
  'CSS_SHOW_STACK_TRACE',
] as const;

const SECRET_KEYS = new Set<string>([
  'CLOUDFLARE_TUNNEL_TOKEN',
  'SAKURA_TUNNEL_TOKEN',
  'NGROK_AUTHTOKEN',
  'FRP_TUNNEL_TOKEN',
  'XPOD_NODE_TOKEN',
  'XPOD_SERVICE_TOKEN',
  'CSS_IDENTITY_DB_URL',
]);

const TUNNEL_PROVIDER_FIELDS: Record<Exclude<TunnelProvider, 'none'>, TunnelProviderFieldSpec> = {
  ngrok: {
    publicEndpointKey: 'NGROK_URL',
    publicEndpointLabel: 'ngrok 固定入口 URL',
    publicEndpointPlaceholder: 'https://example.ngrok-free.dev',
    credentialKey: 'NGROK_AUTHTOKEN',
    credentialLabel: 'ngrok authtoken',
  },
  cloudflare: {
    publicEndpointKey: 'CLOUDFLARE_TUNNEL_URL',
    publicEndpointLabel: 'Cloudflare Tunnel 公开入口',
    publicEndpointPlaceholder: 'https://example.trycloudflare.com',
    credentialKey: 'CLOUDFLARE_TUNNEL_TOKEN',
    credentialLabel: 'Cloudflare Tunnel Token',
  },
  sakura_frp: {
    publicEndpointKey: 'SAKURA_TUNNEL_URL',
    publicEndpointLabel: 'Sakura FRP 公开入口 URL',
    publicEndpointPlaceholder: 'https://example.example.com',
    credentialKey: 'SAKURA_TUNNEL_TOKEN',
    credentialLabel: 'Sakura FRP Token',
  },
  frp: {
    publicEndpointKey: 'FRP_TUNNEL_URL',
    publicEndpointLabel: 'FRP 公开入口 URL',
    publicEndpointPlaceholder: 'https://example.example.com',
    credentialKey: 'FRP_TUNNEL_TOKEN',
    credentialLabel: 'FRP Token',
  },
};

function getTunnelProviderFields(provider: TunnelProvider): TunnelProviderFieldSpec | null {
  return provider === 'none' ? null : TUNNEL_PROVIDER_FIELDS[provider];
}

const TUNNEL_PROFILE_PROVIDERS: Array<Exclude<TunnelProvider, 'none'>> = ['ngrok', 'cloudflare', 'sakura_frp', 'frp'];

function readTunnelProvider(value: string | undefined): TunnelProvider {
  if (value === 'ngrok' || value === 'cloudflare' || value === 'sakura_frp' || value === 'frp') {
    return value;
  }
  if (value === 'sakura-frp') {
    return 'sakura_frp';
  }
  return 'none';
}

function getTunnelProfileLabel(provider: Exclude<TunnelProvider, 'none'>): string {
  switch (provider) {
    case 'ngrok': return 'ngrok';
    case 'cloudflare': return 'Cloudflare';
    case 'sakura_frp': return 'Sakura FRP';
    case 'frp': return 'FRP';
  }
}

function buildTunnelProfileDrafts(
  env: Record<string, string>,
  secretIsPresentOrReplacing: (key: string) => boolean,
): TunnelProfileDraft[] {
  const drafts: TunnelProfileDraft[] = [];
  const seen = new Set<string>();

  for (const stored of parseStoredTunnelProfiles(env.XPOD_TUNNEL_PROFILES)) {
    const fields = TUNNEL_PROVIDER_FIELDS[stored.provider];
    const credentialKey = stored.credentialEnvKey || fields.credentialKey;
    const publicEndpointUrl = stored.publicUrl || readLegacyTunnelEndpoint(env, stored.provider, fields);
    const credentialConfigured = secretIsPresentOrReplacing(credentialKey);
    drafts.push({
      id: stored.id,
      provider: stored.provider,
      label: stored.label || getTunnelProfileLabel(stored.provider),
      publicEndpointUrl,
      credentialConfigured,
      configured: true,
      ...fields,
      credentialKey,
    });
    seen.add(stored.id);
  }

  for (const provider of TUNNEL_PROFILE_PROVIDERS) {
    if (seen.has(provider)) continue;
    const fields = TUNNEL_PROVIDER_FIELDS[provider];
    const publicEndpointUrl = readLegacyTunnelEndpoint(env, provider, fields);
    const credentialConfigured = secretIsPresentOrReplacing(fields.credentialKey);
    drafts.push({
      id: provider,
      provider,
      label: getTunnelProfileLabel(provider),
      publicEndpointUrl,
      credentialConfigured,
      configured: Boolean(publicEndpointUrl || credentialConfigured || readTunnelProvider(env.XPOD_TUNNEL_PROVIDER) === provider),
      ...fields,
    });
  }

  return drafts;
}

type StoredTunnelProfile = {
  id: string;
  provider: Exclude<TunnelProvider, 'none'>;
  label?: string;
  publicUrl?: string;
  credentialEnvKey?: string;
};

function parseStoredTunnelProfiles(value: string | undefined): StoredTunnelProfile[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): StoredTunnelProfile[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : '';
      const provider = readTunnelProvider(typeof record.provider === 'string' ? record.provider : undefined);
      if (!id || provider === 'none') return [];
      return [{
        id,
        provider,
        label: typeof record.label === 'string' ? record.label : undefined,
        publicUrl: typeof record.publicUrl === 'string' ? record.publicUrl : undefined,
        credentialEnvKey: typeof record.credentialEnvKey === 'string' ? record.credentialEnvKey : undefined,
      }];
    });
  } catch {
    return [];
  }
}

function readLegacyTunnelEndpoint(
  env: Record<string, string>,
  provider: Exclude<TunnelProvider, 'none'>,
  fields: TunnelProviderFieldSpec,
): string {
  const legacySharedEndpoint = (provider === 'cloudflare' || provider === 'sakura_frp')
    ? env.XPOD_TUNNEL_PUBLIC_URL || ''
    : '';
  return env[fields.publicEndpointKey] || legacySharedEndpoint || '';
}

function serializeTunnelProfileDrafts(profiles: TunnelProfileDraft[]): string {
  const configured = profiles
    .filter((profile) => profile.configured)
    .map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      label: profile.label,
      publicUrl: profile.publicEndpointUrl,
      credentialEnvKey: profile.credentialKey,
    }));
  return configured.length > 0 ? JSON.stringify(configured) : '';
}

function resolveInitialActiveTunnelProfileId(
  env: Record<string, string>,
  legacyTunnelProvider: TunnelProvider,
  tunnelProfileDrafts: TunnelProfileDraft[],
): string {
  const explicitActiveProfileId = env.XPOD_TUNNEL_ACTIVE_PROFILE_ID?.trim();
  if (explicitActiveProfileId) {
    return explicitActiveProfileId;
  }
  if (legacyTunnelProvider !== 'none') {
    return legacyTunnelProvider;
  }
  return tunnelProfileDrafts.find((profile) => profile.configured)?.id ?? 'none';
}


function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

function fieldChange(env: Record<string, string>, key: string, value: string): Record<string, string> {
  return { ...env, [key]: value };
}

function FormField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  placeholder?: string;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        aria-readonly={props.readOnly || undefined}
      />
      {props.helper ? <p className="text-xs text-muted-foreground">{props.helper}</p> : null}
    </div>
  );
}

export function SettingsPage() {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [originalEnv, setOriginalEnv] = useState<Record<string, string>>({});
  const [secretReplacements, setSecretReplacements] = useState<Record<string, string>>({});
  const [secretConfigured, setSecretConfigured] = useState<Record<string, { configured: boolean }>>({});
  const [publicIpCheckResult, setPublicIpCheckResult] = useState<PublicIpCheckResult | null>(null);
  const [ddnsStatus, setDdnsStatus] = useState<DdnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingIp, setCheckingIp] = useState(false);
  const [message, setMessage] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const mode: DeployMode = env.XPOD_DEPLOY_MODE === 'standalone' ? 'standalone' : 'local';
  const legacyTunnelProvider = readTunnelProvider(env.XPOD_TUNNEL_PROVIDER);
  const httpsMode: HttpsMode = ['none', 'acme', 'manual'].includes(env.XPOD_HTTPS_MODE)
    ? (env.XPOD_HTTPS_MODE as HttpsMode)
    : 'none';
  const publicIpCheck: PublicIpCheckStatus = publicIpCheckResult?.status ?? 'unknown';
  const isLocal = mode === 'local';
  const hasCloudEndpoint = Boolean(env.XPOD_CLOUD_API_ENDPOINT);
  const isManaged = isLocal && hasCloudEndpoint;
  const managedBaseUrl = ddnsStatus?.baseUrl || env.CSS_BASE_URL || (ddnsStatus?.fqdn ? `https://${ddnsStatus.fqdn}/` : '');

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    if (loading) return;
    void refreshPublicIpCheck(isManaged ? managedBaseUrl : env.CSS_BASE_URL);
  }, [env.CSS_BASE_URL, isManaged, managedBaseUrl, mode, loading]);

  useEffect(() => {
    if (loading) return;
    if (isManaged) {
      void loadDdnsStatus();
    } else {
      setDdnsStatus(null);
    }
  }, [isManaged, loading]);

  const loadDdnsStatus = async (): Promise<void> => {
    try {
      const result = await getDdnsStatus();
      setDdnsStatus(result);
    } catch (e) {
      console.error('Failed to load ddns status:', e);
      setDdnsStatus(null);
    }
  };

  const loadConfig = async (): Promise<void> => {
    try {
      const config = await getAdminConfig();
      const loadedEnv = { ...(config?.env ?? {}) };
      setEnv(loadedEnv);
      setOriginalEnv(loadedEnv);
      setSecretReplacements({});
      setSecretConfigured(config?.secrets ?? {});
    } catch (e) {
      console.error('Failed to load config:', e);
    } finally {
      setLoading(false);
    }
  };

  const refreshPublicIpCheck = async (baseUrl?: string): Promise<void> => {
    setCheckingIp(true);
    try {
      const result = await getPublicIpCheck(baseUrl);
      setPublicIpCheckResult(result);
    } catch (e) {
      console.error('Failed to refresh public ip check:', e);
      setPublicIpCheckResult(null);
    } finally {
      setCheckingIp(false);
    }
  };

  const updateEnv = (key: string, value: string): void => {
    setEnv((prev) => fieldChange(prev, key, value));
  };

  const updateSecretReplacement = (key: string, value: string): void => {
    setSecretReplacements((prev) => fieldChange(prev, key, value));
  };

  const secretIsConfigured = useCallback(
    (key: string): boolean => Boolean(secretConfigured[key]?.configured),
    [secretConfigured],
  );
  const secretIsPresentOrReplacing = useCallback(
    (key: string): boolean => secretIsConfigured(key) || Boolean(secretReplacements[key]),
    [secretIsConfigured, secretReplacements],
  );

  const tunnelProfileDrafts = useMemo(
    () => buildTunnelProfileDrafts(env, secretIsPresentOrReplacing),
    [env, secretIsPresentOrReplacing],
  );
  const activeTunnelProfileId = resolveInitialActiveTunnelProfileId(env, legacyTunnelProvider, tunnelProfileDrafts);
  const activeTunnelProfile = tunnelProfileDrafts.find((profile) => profile.id === activeTunnelProfileId);
  const activeTunnelProvider: TunnelProvider = activeTunnelProfile?.provider ?? 'none';
  const tunnelProviderFields = getTunnelProviderFields(activeTunnelProvider);

  const activateTunnelProfile = (profileId: string): void => {
    const nextProfile = tunnelProfileDrafts.find((profile) => profile.id === profileId);
    setEnv((prev) => ({
      ...prev,
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: nextProfile ? nextProfile.id : '',
      XPOD_TUNNEL_PROVIDER: nextProfile?.provider ?? 'none',
    }));
  };

  const updateTunnelProfilePublicEndpoint = (profile: TunnelProfileDraft, value: string): void => {
    const nextProfiles = tunnelProfileDrafts.map((item) => item.id === profile.id
      ? { ...item, publicEndpointUrl: value, configured: true }
      : item);
    setEnv((prev) => ({
      ...prev,
      [profile.publicEndpointKey]: value,
      XPOD_TUNNEL_PROFILES: serializeTunnelProfileDrafts(nextProfiles),
    }));
  };

  const validationError = useMemo(() => {
    if (tunnelProviderFields) {
      if (!(activeTunnelProfile?.publicEndpointUrl || '').trim()) {
        return `请填写 ${tunnelProviderFields.publicEndpointLabel}`;
      }
      if (!secretIsPresentOrReplacing(tunnelProviderFields.credentialKey)) {
        return `请填写 ${tunnelProviderFields.credentialLabel}`;
      }
    }

    if (isManaged && ddnsStatus?.mode === 'tunnel' && activeTunnelProvider === 'none') {
      return '当前网络不可直连，必须启用一个隧道供应商。';
    }

    const baseUrl = (env.CSS_BASE_URL || '').trim();
    const wantsHttps = baseUrl.startsWith('https://');
    if (!isManaged && wantsHttps && activeTunnelProvider === 'none' && httpsMode === 'none') {
      return '独立部署使用 https:// Base URL 时，需要配置 HTTPS 或启用隧道。';
    }

    return '';
  }, [activeTunnelProfile?.publicEndpointUrl, activeTunnelProvider, ddnsStatus?.mode, env.CSS_BASE_URL, httpsMode, isManaged, tunnelProviderFields, secretIsPresentOrReplacing]);

  const pendingChanges = useMemo(() => {
    const changes: Array<{ key: string; from: string; to: string }> = [];
    for (const key of ALLOWED_KEYS) {
      const current = env[key];
      const original = originalEnv[key];
      if (isSecretKey(key)) {
        if (secretReplacements[key]) {
          changes.push({ key, from: secretIsConfigured(key) ? '[configured]' : '', to: '[replace]' });
        }
        continue;
      }
      if ((current ?? '') !== (original ?? '')) {
        changes.push({ key, from: original ?? '', to: current ?? '' });
      }
    }
    return changes;
  }, [env, originalEnv, secretIsConfigured, secretReplacements]);

  const saveConfig = async (): Promise<boolean> => {
    if (validationError) {
      setMessage(validationError);
      return false;
    }

    setSaving(true);
    setMessage('');
    try {
      const patch: Record<string, string> = {};
      for (const key of ALLOWED_KEYS) {
        if (isSecretKey(key)) {
          if (secretReplacements[key]) {
            patch[key] = secretReplacements[key];
          }
        } else if (key in env) {
          patch[key] = env[key];
        }
      }
      patch.XPOD_TUNNEL_ACTIVE_PROFILE_ID = activeTunnelProvider === 'none' ? '' : activeTunnelProfileId;
      patch.XPOD_TUNNEL_PROVIDER = activeTunnelProvider;
      patch.XPOD_TUNNEL_PROFILES = serializeTunnelProfileDrafts(tunnelProfileDrafts);

      const success = await updateAdminConfig(patch);
      if (success) {
        setMessage('配置已保存，需要重启服务生效');
        await loadConfig();
      } else {
        setMessage('保存失败');
      }
      return Boolean(success);
    } catch {
      setMessage('保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async (): Promise<void> => {
    setMessage('正在重启服务...');
    const success = await triggerRestart();
    if (success) {
      setMessage('重启信号已发送，请稍候...');
      setTimeout(() => window.location.reload(), 3000);
    } else {
      setMessage('重启失败。远程访问时默认禁止重启，请在本机或携带管理 Token 操作。');
    }
  };

  const handleSaveAndRestart = async (): Promise<void> => {
    const ok = await saveConfig();
    if (ok) await handleRestart();
  };

  const resetChanges = (): void => {
    setEnv(originalEnv);
    setSecretReplacements({});
    setMessage('未保存变更已重置');
  };

  const statusText = useMemo(() => {
    if (checkingIp) return '检测中...';
    if (publicIpCheck === 'pass') return '可直连';
    if (publicIpCheck === 'fail') return '不可直连';
    return '未知';
  }, [checkingIp, publicIpCheck]);

  if (loading) {
    return (
      <div className="p-4 sm:p-8 max-w-4xl space-y-4">
        <div>
          <h1 className="type-h1">设置</h1>
          <p className="mt-2 text-sm text-muted-foreground">正在读取运行时配置。</p>
        </div>
        <Card variant="bordered">
          <CardContent className="space-y-3 pt-5">
            <div className="h-4 w-40 rounded bg-muted" />
            <div className="h-10 rounded bg-muted" />
            <div className="h-10 rounded bg-muted" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="type-h1">设置</h1>
        <p className="mt-2 text-sm text-muted-foreground">高级运行时设置。大多数用户应在 LinX 中完成配置。</p>
      </div>

      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">高级运行时设置</div>
            <p className="mt-1">这里修改的是本地 Xpod 运行时，不是用户 Pod 资料，也不是 Cloud IDP 账号设置。</p>
          </div>
        </div>
      </div>

      <Card variant="bordered" className="mb-6">
        <CardHeader><CardTitle>运行时</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>部署模式</Label>
              <Select value={mode} onValueChange={(value) => updateEnv('XPOD_DEPLOY_MODE', value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">边缘部署</SelectItem>
                  <SelectItem value="standalone">独立部署</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FormField id="storageRoot" label="存储目录" value={env.CSS_ROOT_FILE_PATH || './data'} onChange={(value) => updateEnv('CSS_ROOT_FILE_PATH', value)} />
          </div>
          <FormField
            id="baseUrl"
            label="资料入口 URL"
            value={isManaged ? managedBaseUrl : (env.CSS_BASE_URL || 'http://127.0.0.1:3000')}
            onChange={(value) => updateEnv('CSS_BASE_URL', value)}
            readOnly={isManaged}
            helper={isManaged ? '托管模式下由 Cloud 分配稳定域名，本地只上报状态和隧道入口。' : '独立部署需要保证该 URL 可被目标客户端访问。'}
          />
          <p className="text-xs text-muted-foreground">
            {mode === 'local'
              ? '边缘部署：Cloud IDP 和稳定域名在云端，数据/SP 保留在本地。'
              : '独立部署：域名、身份认证和证书都由本机或用户自管。'}
          </p>
        </CardContent>
      </Card>

      <Card variant="bordered" className="mb-6">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-4">
            <CardTitle>网络访问</CardTitle>
            <span className="text-sm">
              外网: <span className={clsx(publicIpCheck === 'pass' ? 'text-green-700 dark:text-green-300' : publicIpCheck === 'fail' ? 'text-destructive' : 'text-muted-foreground')}>{statusText}</span>
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isManaged && ddnsStatus?.mode === 'tunnel' && activeTunnelProvider === 'none' ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">当前网络不可直连，请启用一个隧道供应商。</div>
          ) : null}
          <div className="space-y-2">
            <Label>当前生效</Label>
            <Select value={activeTunnelProfileId} onValueChange={activateTunnelProfile}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不使用隧道</SelectItem>
                {tunnelProfileDrafts.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>{profile.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">可以记录多个隧道配置，但同一时间只启用当前选择的一个。公网、局域网、本机和 P2P 由状态页判断最优接入。</p>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">已记录隧道</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {tunnelProfileDrafts.map((profile) => {
                const isActive = profile.id === activeTunnelProfileId;
                return (
                  <div key={profile.id} className={clsx('rounded-xl border p-3', isActive ? 'border-primary bg-primary/5' : 'border-border')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{profile.label}</span>
                      <Button
                        type="button"
                        variant={isActive ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => activateTunnelProfile(profile.id)}
                        disabled={isActive}
                      >
                        {isActive ? '当前生效' : '设为当前'}
                      </Button>
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {profile.publicEndpointUrl || '未配置入口'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {profile.credentialConfigured ? '密钥已配置' : '未配置密钥'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {activeTunnelProfile && tunnelProviderFields ? (
            <div className="space-y-4 rounded-xl border border-border p-4">
              <div className="text-sm font-medium">编辑当前隧道</div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">隧道入口 URL</div>
                <FormField
                  id="tunnelPublicEndpoint"
                  label={tunnelProviderFields.publicEndpointLabel}
                  value={activeTunnelProfile.publicEndpointUrl}
                  onChange={(value) => updateTunnelProfilePublicEndpoint(activeTunnelProfile, value)}
                  placeholder={tunnelProviderFields.publicEndpointPlaceholder}
                  helper="这是实际数据面入口，不替代上方的稳定资料 URL。"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">访问密钥</div>
                <SecretField
                  id="tunnelCredential"
                  label={tunnelProviderFields.credentialLabel}
                  configured={secretIsConfigured(tunnelProviderFields.credentialKey)}
                  value={secretReplacements[tunnelProviderFields.credentialKey] || ''}
                  onChange={(value) => updateSecretReplacement(tunnelProviderFields.credentialKey, value)}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              不使用隧道时，不填写隧道入口 URL 或访问密钥。
            </div>
          )}
        </CardContent>
      </Card>

      <Card variant="bordered" className="mb-6">
        <CardHeader><CardTitle>Cloud 协调</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <FormField id="cloudEndpoint" label="Cloud API endpoint" value={env.XPOD_CLOUD_API_ENDPOINT || ''} onChange={(value) => updateEnv('XPOD_CLOUD_API_ENDPOINT', value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="nodeId" label="nodeId" value={env.XPOD_NODE_ID || ''} onChange={(value) => updateEnv('XPOD_NODE_ID', value)} />
            <FormField id="spDomain" label="spDomain" value={env.XPOD_SP_DOMAIN || ''} onChange={(value) => updateEnv('XPOD_SP_DOMAIN', value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SecretField id="nodeToken" label="Node token" configured={secretIsConfigured('XPOD_NODE_TOKEN')} value={secretReplacements.XPOD_NODE_TOKEN || ''} onChange={(value) => updateSecretReplacement('XPOD_NODE_TOKEN', value)} />
            <SecretField id="serviceToken" label="Service token" configured={secretIsConfigured('XPOD_SERVICE_TOKEN')} value={secretReplacements.XPOD_SERVICE_TOKEN || ''} onChange={(value) => updateSecretReplacement('XPOD_SERVICE_TOKEN', value)} />
          </div>
        </CardContent>
      </Card>

      {mode === 'standalone' ? (
        <Card variant="bordered" className="mb-6">
          <CardHeader><CardTitle>HTTPS</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>HTTPS 模式</Label>
              <Select value={httpsMode} onValueChange={(value) => updateEnv('XPOD_HTTPS_MODE', value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">关闭</SelectItem>
                  <SelectItem value="acme">自动申请 ACME</SelectItem>
                  <SelectItem value="manual">手动证书</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {httpsMode === 'manual' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="certPath" label="证书路径" value={env.XPOD_HTTPS_CERT_PATH || ''} onChange={(value) => updateEnv('XPOD_HTTPS_CERT_PATH', value)} />
                <FormField id="keyPath" label="私钥路径" value={env.XPOD_HTTPS_KEY_PATH || ''} onChange={(value) => updateEnv('XPOD_HTTPS_KEY_PATH', value)} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? '收起高级设置' : '展开高级设置'}
        </Button>
      </div>

      {advancedOpen ? (
        <Card variant="bordered" className="mb-6">
          <CardHeader><CardTitle>高级设置</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <FormField id="cssPort" label="端口" value={env.CSS_PORT || '3000'} onChange={(value) => updateEnv('CSS_PORT', value)} />
            <FormField id="sparqlEndpoint" label="SPARQL 存储" value={env.CSS_SPARQL_ENDPOINT || ''} onChange={(value) => updateEnv('CSS_SPARQL_ENDPOINT', value)} />
            <SecretField id="identityDb" label="身份数据库 URL" configured={secretIsConfigured('CSS_IDENTITY_DB_URL')} value={secretReplacements.CSS_IDENTITY_DB_URL || ''} onChange={(value) => updateSecretReplacement('CSS_IDENTITY_DB_URL', value)} />
            <div className="space-y-2">
              <Label>日志级别</Label>
              <Select value={env.CSS_LOGGING_LEVEL || 'info'} onValueChange={(value) => updateEnv('CSS_LOGGING_LEVEL', value)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="error">error</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="debug">debug</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                id="showStackTrace"
                checked={env.CSS_SHOW_STACK_TRACE === 'true'}
                onChange={(e) => updateEnv('CSS_SHOW_STACK_TRACE', e.target.checked ? 'true' : 'false')}
                className="rounded border-input"
              />
              显示错误堆栈
            </label>
          </CardContent>
        </Card>
      ) : null}

      <PendingChangesPanel changes={pendingChanges} onReset={resetChanges} />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void saveConfig()} disabled={saving || Boolean(validationError)}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
        <Button variant="secondary" onClick={() => void handleSaveAndRestart()} disabled={saving || Boolean(validationError)}>
          保存并重启
        </Button>
      </div>

      {(message || validationError) ? (
        <div
          className={clsx(
            'mt-4 rounded-md border px-3 py-2 text-sm',
            validationError || (message && message.includes('失败'))
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-200',
          )}
        >
          {message || validationError}
        </div>
      ) : null}
    </div>
  );
}

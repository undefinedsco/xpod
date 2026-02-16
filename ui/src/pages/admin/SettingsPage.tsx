/**
 * Settings 页面 - 面向产品配置层（LinX 侧 5 项主配置）
 */

import { useEffect, useMemo, useState } from 'react';
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
type TunnelProvider = 'none' | 'cloudflare' | 'sakura_frp';
type HttpsMode = 'none' | 'acme' | 'manual';
type PublicIpCheckStatus = 'pass' | 'fail' | 'unknown';

const ALLOWED_KEYS = [
  // 5 params
  'XPOD_DEPLOY_MODE',
  'CSS_ROOT_FILE_PATH',
  'CSS_BASE_URL',
  'XPOD_TUNNEL_PROVIDER',
  'CLOUDFLARE_TUNNEL_TOKEN',
  'SAKURA_TUNNEL_TOKEN',
  'XPOD_HTTPS_MODE',
  'XPOD_HTTPS_CERT_PATH',
  'XPOD_HTTPS_KEY_PATH',

  // Advanced
  'CSS_PORT',
  'CSS_SPARQL_ENDPOINT',
  'CSS_IDENTITY_DB_URL',
  'CSS_LOGGING_LEVEL',
  'CSS_SHOW_STACK_TRACE',
] as const;

export function SettingsPage() {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [publicIpCheckResult, setPublicIpCheckResult] = useState<PublicIpCheckResult | null>(null);
  const [ddnsStatus, setDdnsStatus] = useState<DdnsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingIp, setCheckingIp] = useState(false);
  const [message, setMessage] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const mode: DeployMode = env.XPOD_DEPLOY_MODE === 'standalone' ? 'standalone' : 'local';
  const tunnelProvider: TunnelProvider = ['none', 'cloudflare', 'sakura_frp'].includes(env.XPOD_TUNNEL_PROVIDER)
    ? (env.XPOD_TUNNEL_PROVIDER as TunnelProvider)
    : 'none';
  const httpsMode: HttpsMode = ['none', 'acme', 'manual'].includes(env.XPOD_HTTPS_MODE)
    ? (env.XPOD_HTTPS_MODE as HttpsMode)
    : 'none';
  const publicIpCheck: PublicIpCheckStatus = publicIpCheckResult?.status ?? 'unknown';
  const isLocal = mode === 'local';
  const hasCloudEndpoint = Boolean(env.XPOD_CLOUD_API_ENDPOINT);
  const canSelectLocal = hasCloudEndpoint;
  // 只有 Local 模式且配置了 Cloud 端点才是托管模式
  const isManaged = isLocal && canSelectLocal;

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    // Auto-run check on page enter / baseUrl changes.
    if (loading) {
      return;
    }

    void refreshPublicIpCheck(env.CSS_BASE_URL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.CSS_BASE_URL, mode, loading]);

  useEffect(() => {
    if (loading) {
      return;
    }
    if (isManaged) {
      void loadDdnsStatus();
    } else {
      setDdnsStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (config) {
        setEnv({ ...config.env });
      }
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
        if (key in env) {
          patch[key] = env[key];
        }
      }

      const success = await updateAdminConfig(patch);
      setMessage(success ? '配置已保存，需要重启服务生效' : '保存失败');
      return Boolean(success);
    } catch (e) {
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
      setMessage('重启失败');
    }
  };

  const handleSaveAndRestart = async (): Promise<void> => {
    const ok = await saveConfig();
    if (!ok) {
      return;
    }
    await handleRestart();
  };

  const updateEnv = (key: string, value: string): void => {
    setEnv((prev) => ({ ...prev, [key]: value }));
  };

  const validationError = useMemo(() => {
    // Tunnel token requirements (only when selected)
    if (tunnelProvider === 'cloudflare' && !env.CLOUDFLARE_TUNNEL_TOKEN) {
      return '请填写 Cloudflare Tunnel Token';
    }
    if (tunnelProvider === 'sakura_frp' && !env.SAKURA_TUNNEL_TOKEN) {
      return '请填写 Sakura Tunnel Token';
    }

    // Local managed mode: if Cloud decided tunnel mode, we must enable a tunnel provider locally.
    if (isManaged && ddnsStatus?.mode === 'tunnel' && tunnelProvider === 'none') {
      return '当前网络不可直连，必须启用隧道（选择供应商并填写 Token）';
    }

    // Standalone: HTTPS is only required when you want https without an edge tunnel terminating TLS.
    const baseUrl = (env.CSS_BASE_URL || '').trim();
    const wantsHttps = baseUrl.startsWith('https://');
    if (!isManaged && wantsHttps && tunnelProvider === 'none' && httpsMode === 'none') {
      return '独立部署使用 https:// Base URL 时，需要配置 HTTPS（或启用隧道由边缘终止 TLS）';
    }

    return '';
  }, [
    ddnsStatus?.mode,
    env.CLOUDFLARE_TUNNEL_TOKEN,
    env.SAKURA_TUNNEL_TOKEN,
    env.CSS_BASE_URL,
    httpsMode,
    isManaged,
    mode,
    tunnelProvider,
  ]);

  const statusText = useMemo(() => {
    if (checkingIp) return '检测中...';
    if (publicIpCheck === 'pass') return '✓ 可直连';
    if (publicIpCheck === 'fail') return '✗ 不可直连';
    return '? 未知';
  }, [checkingIp, publicIpCheck]);

  if (loading) {
    return <div className="p-8 text-foreground">加载中...</div>;
  }

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="type-h1 mb-4">设置</h1>

      <Card variant="bordered" className="mb-6">
        <CardHeader><CardTitle>存储目录</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Input value={env.CSS_ROOT_FILE_PATH || './data'} onChange={(e) => updateEnv('CSS_ROOT_FILE_PATH', e.target.value)} />
        </CardContent>
      </Card>

      {/* 访问地址 */}
      <Card variant="bordered" className="mb-6">
        <CardHeader><CardTitle>访问地址</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {/* 部署模式 + Base URL */}
          <div className="flex items-center gap-2">
            <Select value={mode} onValueChange={(value) => updateEnv('XPOD_DEPLOY_MODE', value)}>
              <SelectTrigger className="w-36 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">边缘部署</SelectItem>
                <SelectItem value="standalone">独立部署</SelectItem>
              </SelectContent>
            </Select>
            {isManaged ? (
              <span className="text-sm text-muted-foreground flex-1">
                {ddnsStatus?.fqdn || '（等待分配）'}
              </span>
            ) : (
              <Input
                className="flex-1"
                value={env.CSS_BASE_URL || 'http://127.0.0.1:3000'}
                onChange={(e) => updateEnv('CSS_BASE_URL', e.target.value)}
                placeholder="https://your-domain.com"
              />
            )}
          </div>

          {/* 说明 */}
          <div className="text-xs text-muted-foreground">
            {mode === 'local'
              ? '边缘部署：接入云端，自动获得域名、身份认证和HTTPS证书，数据保留在本地'
              : '独立部署：完全独立运行，域名、身份认证和证书需自行配置'}
          </div>
        </CardContent>
      </Card>


      <Card variant="bordered" className="mb-6">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle>隧道供应商</CardTitle>
              <span className="text-sm">
                外网:
                <span
                  className={clsx(
                    'ml-1',
                    publicIpCheck === 'pass'
                      ? 'text-green-600'
                      : publicIpCheck === 'fail'
                        ? 'text-red-600'
                        : 'text-muted-foreground',
                  )}
                >
                  {statusText}
                </span>
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {isManaged && ddnsStatus?.mode === 'tunnel' ? (
              <div className="text-xs text-destructive">当前网络不可直连，请选择隧道供应商并填写 Token。</div>
            ) : null}
            {mode === 'standalone' ? (
              <div className="text-xs text-muted-foreground">独立部署下仅当没有公网 IP 时才需要隧道，有公网 IP 可不配置。</div>
            ) : null}
            <div className="flex items-center gap-2">
              <Select value={tunnelProvider} onValueChange={(value) => updateEnv('XPOD_TUNNEL_PROVIDER', value)}>
                <SelectTrigger className="w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不使用隧道</SelectItem>
                  <SelectItem value="cloudflare">Cloudflare</SelectItem>
                  <SelectItem value="sakura_frp">Sakura FRP</SelectItem>
                </SelectContent>
              </Select>
              {tunnelProvider === 'cloudflare' && (
                <Input
                  className="flex-1"
                  placeholder="Cloudflare Tunnel Token"
                  value={env.CLOUDFLARE_TUNNEL_TOKEN || ''}
                  onChange={(e) => updateEnv('CLOUDFLARE_TUNNEL_TOKEN', e.target.value)}
                />
              )}
              {tunnelProvider === 'sakura_frp' && (
                <Input
                  className="flex-1"
                  placeholder="Sakura Tunnel Token"
                  value={env.SAKURA_TUNNEL_TOKEN}
                  onChange={(e) => updateEnv('SAKURA_TUNNEL_TOKEN', e.target.value)}
                />
              )}
            </div>
          </CardContent>
        </Card>

      {/* 独立部署才需要手动配置 HTTPS */}
      {mode === 'standalone' && (
        <Card variant="bordered" className="mb-6">
          <CardHeader><CardTitle>https证书</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Select value={httpsMode} onValueChange={(value) => updateEnv('XPOD_HTTPS_MODE', value)}>
              <SelectTrigger className="w-36 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">关闭</SelectItem>
                <SelectItem value="acme">自动申请 (ACME)</SelectItem>
                <SelectItem value="manual">手动证书</SelectItem>
              </SelectContent>
            </Select>
            {httpsMode === 'manual' && (
              <>
                <Input
                  className="flex-1"
                  placeholder="证书路径 (PEM)"
                  value={env.XPOD_HTTPS_CERT_PATH || ''}
                  onChange={(e) => updateEnv('XPOD_HTTPS_CERT_PATH', e.target.value)}
                />
                <Input
                  className="flex-1"
                  placeholder="私钥路径 (PEM)"
                  value={env.XPOD_HTTPS_KEY_PATH || ''}
                  onChange={(e) => updateEnv('XPOD_HTTPS_KEY_PATH', e.target.value)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>
      )}

      <div className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? '收起高级设置' : '展开高级设置'}
        </Button>
      </div>

      {advancedOpen && (
        <Card variant="bordered" className="mb-6">
          <CardHeader><CardTitle>高级设置</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>端口</Label>
              <Input value={env.CSS_PORT || '3000'} onChange={(e) => updateEnv('CSS_PORT', e.target.value)} />
            </div>
            <div>
              <Label>SPARQL 存储</Label>
              <Input value={env.CSS_SPARQL_ENDPOINT || ''} onChange={(e) => updateEnv('CSS_SPARQL_ENDPOINT', e.target.value)} />
            </div>
            <div>
              <Label>身份数据库</Label>
              <Input value={env.CSS_IDENTITY_DB_URL || ''} onChange={(e) => updateEnv('CSS_IDENTITY_DB_URL', e.target.value)} />
            </div>
            <div>
              <Label>日志级别</Label>
              <Select value={env.CSS_LOGGING_LEVEL || 'info'} onValueChange={(value) => updateEnv('CSS_LOGGING_LEVEL', value)}>
                <SelectTrigger className="w-40 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="error">error</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="debug">debug</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="showStackTrace"
                checked={env.CSS_SHOW_STACK_TRACE === 'true'}
                onChange={(e) => updateEnv('CSS_SHOW_STACK_TRACE', e.target.checked ? 'true' : 'false')}
                className="rounded border-input"
              />
              <label htmlFor="showStackTrace" className="text-sm text-foreground">显示错误堆栈</label>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-4">
        <Button onClick={() => void saveConfig()} disabled={saving || Boolean(validationError)}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
        <Button variant="secondary" onClick={() => void handleSaveAndRestart()} disabled={saving || Boolean(validationError)}>
          保存并重启
        </Button>
      </div>

      {(message || validationError) && (
        <div
          className={clsx(
            'mt-4 text-sm',
            validationError || (message && message.includes('失败')) ? 'text-destructive' : 'text-green-500',
          )}
        >
          {message || validationError}
        </div>
      )}
    </div>
  );
}

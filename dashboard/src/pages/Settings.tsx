// Settings - Configuration page
import { useEffect, useState } from 'react';

interface Config {
  mode: 'local' | 'standalone';
  data_dir: string;
  port: number;
  subdomain?: string;
  domain?: string;
  tunnel: 'none' | 'frp' | 'cloudflare';
}

export function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      // TODO: Load from API
      setConfig({
        mode: 'local',
        data_dir: '/data/xpod',
        port: 3100,
        tunnel: 'none',
      });
    } catch (e) {
      console.error('Failed to load config:', e);
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    setMessage('');
    try {
      // TODO: Save via API
      setMessage('配置已保存，需要重启服务生效');
    } catch (e) {
      setMessage(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-foreground">加载中...</div>;
  }

  if (!config) {
    return <div className="p-8 text-destructive">加载配置失败</div>;
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="type-h1 mb-8">设置</h1>

      {/* Basic Settings */}
      <section className="mb-8">
        <h2 className="type-h2 text-primary mb-5">基本设置</h2>

        <div className="mb-5">
          <label className="block text-muted-foreground mb-2">数据目录</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={config.data_dir}
              onChange={(e) => setConfig({ ...config, data_dir: e.target.value })}
              className="flex-1 px-3 py-2 bg-background border border-input rounded-md text-foreground"
            />
          </div>
        </div>

        <div className="mb-5">
          <label className="block text-muted-foreground mb-2">端口</label>
          <input
            type="number"
            value={config.port}
            onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) })}
            className="w-32 px-3 py-2 bg-background border border-input rounded-md text-foreground"
          />
        </div>
      </section>

      {/* Domain Settings */}
      <section className="mb-8">
        <h2 className="type-h2 text-primary mb-5">域名配置</h2>

        <div className="mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={config.mode === 'local'}
              onChange={() => setConfig({ ...config, mode: 'local' })}
            />
            <span>使用 xpod.cloud 子域名</span>
          </label>
          {config.mode === 'local' && (
            <div className="ml-6 mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="子域名"
                value={config.subdomain || ''}
                onChange={(e) => setConfig({ ...config, subdomain: e.target.value })}
                className="px-3 py-1.5 bg-background border border-input rounded-md text-foreground w-40"
              />
              <span className="text-muted-foreground">.pods.xpod.cloud</span>
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={config.mode === 'standalone'}
              onChange={() => setConfig({ ...config, mode: 'standalone' })}
            />
            <span>使用自己的域名</span>
          </label>
          {config.mode === 'standalone' && (
            <div className="ml-6 mt-2">
              <input
                type="text"
                placeholder="pod.example.com"
                value={config.domain || ''}
                onChange={(e) => setConfig({ ...config, domain: e.target.value })}
                className="px-3 py-1.5 bg-background border border-input rounded-md text-foreground w-64"
              />
            </div>
          )}
        </div>
      </section>

      {/* Tunnel Settings */}
      <section className="mb-8">
        <h2 className="type-h2 text-primary mb-5">隧道配置</h2>
        <select
          value={config.tunnel}
          onChange={(e) => setConfig({ ...config, tunnel: e.target.value as any })}
          className="w-full px-3 py-2 bg-background border border-input rounded-md text-foreground"
        >
          <option value="none">不启用（仅本地访问）</option>
          <option value="cloudflare">Cloudflare Tunnel</option>
          <option value="frp">FRP 隧道</option>
        </select>
      </section>

      {/* Actions */}
      <div>
        <button
          onClick={saveConfig}
          disabled={saving}
          className="btn-warm disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存配置'}
        </button>

        {message && (
          <div className={`mt-4 ${message.includes('失败') ? 'text-destructive' : 'text-green-500'}`}>
            {message}
          </div>
        )}
      </div>
    </div>
  );
}

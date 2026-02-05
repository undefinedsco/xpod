// Setup Wizard - First time configuration
import { useState, useEffect } from 'react';

interface Config {
  mode: 'local' | 'standalone';
  data_dir: string;
  port: number;
  subdomain?: string;
  domain?: string;
  tunnel: 'none' | 'frp' | 'cloudflare';
  has_public_ip?: boolean;
  public_ip?: string;
}

interface NetworkInfo {
  has_public_ip: boolean;
  public_ip?: string;
}

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState<Config>({
    mode: 'local',
    data_dir: '',
    port: 3100,
    tunnel: 'none',
  });
  const [, setNetwork] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load default data directory on mount
  useEffect(() => {
    const defaultDir = '~/xpod/data';
    setConfig(c => ({ ...c, data_dir: defaultDir }));

    // Detect network (mock)
    setNetwork({ has_public_ip: false });
  }, []);

  const handleComplete = async () => {
    setLoading(true);
    setError('');
    try {
      // TODO: Save config via API
      localStorage.setItem('xpod_configured', 'true');
      onComplete();
    } catch (e) {
      setError(`配置失败: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const renderStep1 = () => (
    <div className="space-y-6">
      <h2 className="type-h2 text-center">欢迎使用 Xpod</h2>
      <p className="type-body text-muted-foreground text-center">
        Xpod 是一个个人数据存储和分享平台，基于 Solid 协议构建。
      </p>

      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => setConfig(c => ({ ...c, mode: 'local' }))}
          className={`p-6 border rounded-lg text-left transition-all ${
            config.mode === 'local'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/50'
          }`}
        >
          <div className="font-medium mb-2">使用 xpod.cloud 子域名</div>
          <div className="text-sm text-muted-foreground">
            自动分配子域名，无需配置 DNS
          </div>
        </button>

        <button
          onClick={() => setConfig(c => ({ ...c, mode: 'standalone' }))}
          className={`p-6 border rounded-lg text-left transition-all ${
            config.mode === 'standalone'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/50'
          }`}
        >
          <div className="font-medium mb-2">使用自己的域名</div>
          <div className="text-sm text-muted-foreground">
            需要配置 DNS 和 SSL 证书
          </div>
        </button>
      </div>

      <button
        onClick={() => setStep(2)}
        className="btn-warm w-full"
      >
        下一步
      </button>
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-6">
      <h2 className="type-h2 text-center">配置数据目录</h2>

      <div>
        <label className="block text-muted-foreground mb-2">数据存储位置</label>
        <input
          type="text"
          value={config.data_dir}
          onChange={(e) => setConfig(c => ({ ...c, data_dir: e.target.value }))}
          className="w-full px-3 py-2 bg-background border border-input rounded-md text-foreground"
          placeholder="~/xpod/data"
        />
        <p className="text-xs text-muted-foreground mt-1">
          数据目录用于存储 Pod 数据、配置文件和日志
        </p>
      </div>

      <div>
        <label className="block text-muted-foreground mb-2">服务端口</label>
        <input
          type="number"
          value={config.port}
          onChange={(e) => setConfig(c => ({ ...c, port: parseInt(e.target.value) }))}
          className="w-32 px-3 py-2 bg-background border border-input rounded-md text-foreground"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setStep(1)}
          className="flex-1 py-2 border border-border rounded-md hover:bg-muted transition-colors"
        >
          上一步
        </button>
        <button
          onClick={() => setStep(3)}
          className="flex-1 btn-warm"
        >
          下一步
        </button>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-6">
      <h2 className="type-h2 text-center">网络配置</h2>

      {config.mode === 'local' && (
        <div>
          <label className="block text-muted-foreground mb-2">子域名</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={config.subdomain || ''}
              onChange={(e) => setConfig(c => ({ ...c, subdomain: e.target.value }))}
              className="flex-1 px-3 py-2 bg-background border border-input rounded-md text-foreground"
              placeholder="yourname"
            />
            <span className="text-muted-foreground">.pods.xpod.cloud</span>
          </div>
        </div>
      )}

      {config.mode === 'standalone' && (
        <div>
          <label className="block text-muted-foreground mb-2">域名</label>
          <input
            type="text"
            value={config.domain || ''}
            onChange={(e) => setConfig(c => ({ ...c, domain: e.target.value }))}
            className="w-full px-3 py-2 bg-background border border-input rounded-md text-foreground"
            placeholder="pod.example.com"
          />
        </div>
      )}

      <div>
        <label className="block text-muted-foreground mb-2">外网访问</label>
        <select
          value={config.tunnel}
          onChange={(e) => setConfig(c => ({ ...c, tunnel: e.target.value as any }))}
          className="w-full px-3 py-2 bg-background border border-input rounded-md text-foreground"
        >
          <option value="none">不启用（仅本地访问）</option>
          <option value="cloudflare">Cloudflare Tunnel</option>
          <option value="frp">FRP 隧道</option>
        </select>
      </div>

      {error && (
        <div className="text-destructive text-sm">{error}</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setStep(2)}
          className="flex-1 py-2 border border-border rounded-md hover:bg-muted transition-colors"
        >
          上一步
        </button>
        <button
          onClick={handleComplete}
          disabled={loading}
          className="flex-1 btn-warm disabled:opacity-50"
        >
          {loading ? '配置中...' : '完成配置'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md warm-card p-8">
        <div className="mb-8">
          <div className="flex justify-center gap-2 mb-6">
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full ${
                  i === step ? 'bg-primary' : 'bg-muted'
                }`}
              />
            ))}
          </div>
        </div>

        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </div>
  );
}

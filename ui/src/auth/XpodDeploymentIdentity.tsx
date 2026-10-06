import { useEffect, useState, type ReactNode } from 'react';
import { BrandInfo, XpodMark } from '@undefineds.co/shared-ui';

interface DeploymentIdentity {
  edition: 'cloud' | 'local';
  managed: boolean;
  oidcIssuer?: string;
  publicUrl?: string;
}

function parseIdentity(value: unknown): DeploymentIdentity {
  if (!value || typeof value !== 'object') throw new Error('Missing deployment identity');
  const data = value as Record<string, unknown>;
  if ((data.edition !== 'cloud' && data.edition !== 'local') || typeof data.managed !== 'boolean') {
    throw new Error('Invalid deployment identity');
  }
  let oidcIssuer: string | undefined;
  if (data.edition === 'local' && data.managed && typeof data.oidcIssuer === 'string') {
    const url = new URL(data.oidcIssuer);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid account service');
    }
    oidcIssuer = url.href.replace(/\/$/u, '');
  }
  let publicUrl: string | undefined;
  if (typeof data.publicUrl === 'string') {
    const url = new URL(data.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid public service address');
    }
    publicUrl = url.href;
  }
  return { edition: data.edition, managed: data.managed, oidcIssuer, publicUrl };
}

/** Display-only metadata: authentication and authorization never depend on this label. */
export function XpodDeploymentIdentity({ renderLogo, className }: {
  renderLogo?: (deploymentLabel: string) => ReactNode;
  className?: string;
} = {}) {
  const [identity, setIdentity] = useState<DeploymentIdentity | null>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/service-info', {
          headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Deployment identity unavailable');
        const result = parseIdentity(await response.json());
        if (!controller.signal.aborted) setIdentity(result);
      } catch {
        if (!controller.signal.aborted) setIdentity(null);
      }
    })();
    return () => controller.abort();
  }, []);
  const label = identity
    ? identity.edition === 'cloud' ? '云端'
      : identity.managed ? '托管部署' : '独立部署'
    : identity === null ? '部署信息暂不可用' : '正在识别部署…';
  const logo = renderLogo ? renderLogo(label) : (
    <span data-testid="xpod-deployment-logo" className="inline-flex flex-col items-center gap-0.5">
      <XpodMark size={24} />
      <span className="text-[8px] font-medium leading-none text-primary">{identity ? label : identity === null ? '未知' : '…'}</span>
      {!identity ? <span className="sr-only">{label}</span> : null}
    </span>
  );
  return (
    <div data-testid="xpod-deployment-identity" className={className}>
      <BrandInfo logo={logo} infoLabel="部署详情" info={(
        <div className="space-y-2 leading-relaxed">
          <p className="font-semibold">部署详情</p>
          {identity ? <p>部署类型：{identity.edition === 'cloud' ? 'Cloud' : identity.managed ? 'Local · 云端托管' : 'Local · 独立部署'}</p> : <p>{label}</p>}
          <p>当前访问：<span className="font-mono">{window.location.origin}</span></p>
          {identity ? <p>{identity.edition === 'local' ? '节点地址' : '服务地址'}：<span className="font-mono">{identity.publicUrl ?? (identity.managed ? '尚未分配' : '尚未配置')}</span></p> : null}
          {identity?.oidcIssuer && identity.oidcIssuer !== window.location.origin ? (
            <p>账号服务：<span className="font-mono">{identity.oidcIssuer}</span></p>
          ) : null}
        </div>
      )} />
    </div>
  );
}

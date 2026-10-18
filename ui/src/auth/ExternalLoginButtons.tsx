import { useState } from 'react';
import { Button } from '@undefineds.co/shared-ui';
import { useAuth } from '../context/AuthContextValue';
import { scopeAccountUrl } from '../utils/account-interaction-url';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { beginExternalLogin } from './external-login';

/** All entries come from the server capability registry; no provider identity branches in UI. */
export function ExternalLoginButtons({ intent = 'login', remember = false, disabled = false }: {
  intent?: 'login' | 'register' | 'link'; remember?: boolean; disabled?: boolean;
}) {
  const { controls, refetchControls, accountFetch } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const entries = Object.entries(controls?.externalLogins ?? {});
  if (!entries.length) return null;
  const act = async (login: string, remove = false) => {
    if (pending || disabled) return;
    setPending(true);
    setError('');
    try {
      const url = scopeAccountUrl(login);
      if (remove) {
        const target = new URL(url, window.location.origin);
        if (target.origin !== window.location.origin || !target.pathname.startsWith('/.account/')) throw new Error('账号服务地址无效。');
        const response = await (accountFetch ?? fetch)(target.href, { method: 'DELETE', credentials: 'include', redirect: 'error', headers: storedAccountTokenHeaders({ accept: 'application/json' }) });
        if (!response.ok) throw new Error('无法解除绑定，请确保账号仍有其他登录方式。');
        await refetchControls();
      } else {
        window.location.assign(await beginExternalLogin(url, intent, remember, intent === 'link' ? accountFetch ?? fetch : fetch));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录暂时不可用，请重试。');
    } finally { setPending(false); }
  };
  return <div className="space-y-2" aria-label="其他账号登录方式">
    {entries.map(([id, provider]) => <div key={id} className="flex gap-2">
      {intent !== 'link' || !provider.linked ? <Button type="button" variant="outline" className="w-full" disabled={pending || disabled} onClick={() => void act(provider.login)}>
        {intent === 'link' ? `绑定${provider.name}` : intent === 'register' ? `使用${provider.name}创建账号` : `${provider.name}登录`}
      </Button> : null}
      {intent === 'link' && provider.linked ? <Button type="button" variant="outline" disabled={pending || disabled} onClick={() => void act(provider.login, true)}>解除绑定{provider.name}</Button> : null}
    </div>)}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </div>;
}

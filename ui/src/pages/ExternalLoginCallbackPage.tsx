import { useEffect, useRef, useState } from 'react';
import { completeExternalLogin, ExternalLoginCallbackError } from '../auth/external-login';
import { storeAccountSessionToken } from '../utils/account-session';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';

export function ExternalLoginCallbackPage() {
  const started = useRef(false);
  const [error, setError] = useState('');
  const [retryTo, setRetryTo] = useState('/.account/login/password/');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeExternalLogin().then(result => {
      storeAccountSessionToken(result.authorization);
      window.location.replace(result.location);
    }).catch(cause => {
      if (cause instanceof ExternalLoginCallbackError) setRetryTo(cause.retryTo);
      setError(cause instanceof Error ? cause.message : '登录未完成，请重试。');
    });
  }, []);
  return <XpodAccountPageSurface title="完成账号登录">
    {error ? <div><p role="alert">{error}</p><a href={retryTo}>返回登录或创建账号</a></div> : <p role="status">正在验证授权，请稍候…</p>}
  </XpodAccountPageSurface>;
}

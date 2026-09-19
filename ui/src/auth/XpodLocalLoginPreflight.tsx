import { useContext, useEffect, useRef } from 'react';
import { LoginRestoringView } from '@undefineds.co/shared-ui';
import { AuthContext } from '../context/AuthContextValue';

/**
 * 登录预检只等待身份发现，不再内嵌建 Pod（设计第二部分 §4.1 / U07）。
 *
 * 账号已登录不等于 Pod 就绪：登录必须在零 Pod 时继续，Pod 由 Pod 管理页的
 * 显式操作创建。这里只负责"等 Account 发现结束"，不做任何侧写。
 */
export function XpodLocalLoginPreflight({ onReady }: { onReady: () => void }) {
  const account = useContext(AuthContext);
  const continued = useRef(false);
  const checking = account?.isInitializing === true;
  // A cross-origin Account API token does not establish the IdP's browser
  // session. Anonymous users must register/sign in inside the original OIDC
  // interaction so registration can continue straight to consent.
  useEffect(() => {
    if (!checking && !continued.current) {
      continued.current = true;
      onReady();
    }
  }, [checking, onReady]);

  return <LoginRestoringView label="正在准备登录…" />;
}

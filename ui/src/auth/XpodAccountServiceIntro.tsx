import { XpodMark } from '@undefineds.co/shared-ui';

export interface XpodAccountServiceIntroProps {
  /** Shown under the service name; the same host the sign-in service bar prints. */
  serviceHost?: string;
  locale?: 'zh-CN' | 'en';
}

const introCopy = {
  'zh-CN': {
    name: 'Xpod 账号服务',
    proposition: '一个账号，管理你的 WebID 和它背后的 Pod。',
    points: [
      { title: 'WebID 是你的身份', detail: '登录应用时使用它；数据存在你自己的 Pod 里。' },
      { title: 'Pod 存在哪里由你决定', detail: 'Xpod 云端或你自己的设备，创建后可以在这里查看。' },
      { title: '密钥按需签发', detail: '为脚本或服务单独创建凭据，不再需要就撤销。' },
    ],
  },
  en: {
    name: 'Xpod accounts',
    proposition: 'One account for your WebID and the Pod behind it.',
    points: [
      { title: 'Your WebID is your identity', detail: 'Apps sign you in with it; your data stays in your own Pod.' },
      { title: 'You choose where the Pod lives', detail: 'Xpod cloud or your own device, reviewable here after creation.' },
      { title: 'Credentials on demand', detail: 'Issue a key per script or service, and revoke it when it is done.' },
    ],
  },
} as const;

/**
 * The sign-in-service introduction column of a `page` frame (spec §4/§8.1).
 * It is the account service's own content, so it lives with the account
 * service and not in the shared library, which must never hardcode "Xpod".
 */
export function XpodAccountServiceIntro({ serviceHost, locale = 'zh-CN' }: XpodAccountServiceIntroProps) {
  const text = introCopy[locale];
  return (
    <div data-testid="web-account-introduction" className="flex max-w-[460px] flex-col gap-7">
      <div className="flex items-center gap-3">
        <XpodMark size={44} />
        <span className="text-[22px] font-semibold leading-none text-foreground">{text.name}</span>
      </div>
      <div className="flex flex-col gap-3">
        <h2 className="m-0 text-[28px] font-semibold leading-[38px] text-foreground">{text.proposition}</h2>
        {serviceHost ? <p className="font-mono text-xs text-muted-foreground">{serviceHost}</p> : null}
      </div>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {text.points.map((point) => (
          <li key={point.title} className="flex gap-3">
            <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold text-foreground">{point.title}</span>
              <span className="text-sm leading-[22px] text-muted-foreground">{point.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

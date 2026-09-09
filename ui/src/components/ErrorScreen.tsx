import { Button } from '@undefineds.co/shared-ui';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';

interface ErrorScreenProps {
  message: string;
  retry?: () => void | Promise<void>;
}

export function ErrorScreen({ message, retry }: ErrorScreenProps) {
  return (
    <XpodAccountPageSurface title="账号服务暂时不可用">
      <div className="space-y-6">
        <p role="alert" className="text-sm leading-relaxed text-muted-foreground">
          无法读取账号服务信息。请重试当前步骤，无需重新注册或清除登录状态。
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">技术详情</summary>
          <p className="mt-2 break-words">{message}</p>
        </details>
        <Button type="button" className="w-full" onClick={() => retry ? void retry() : window.location.reload()}>
          重试
        </Button>
      </div>
    </XpodAccountPageSurface>
  );
}

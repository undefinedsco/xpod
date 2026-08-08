import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Input,
  LoginAccountView,
  LoginCardShell,
  LoginFailureView,
  LoginProviderListView,
  LoginRestoringView,
  LoginStorageConflictView,
  Toaster,
  dismissToast,
  toast,
  cn,
} from '../src'

describe('@undefineds.co/shared-ui', () => {
  it('exports the controls required by standalone applets', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardTitle>AI Connection</CardTitle>
        <CardContent>
          <Input aria-label="API Key" />
          <Button variant="outline">Connect</Button>
          <Badge>Ready</Badge>
        </CardContent>
      </Card>,
    )

    expect(html).toContain('AI Connection')
    expect(html).toContain('aria-label="API Key"')
    expect(html).toContain('Connect')
    expect(html).toContain('Ready')
  })

  it('merges utility classes consistently across hosts', () => {
    expect(cn('px-2', false && 'hidden', 'px-4')).toBe('px-4')
  })

  it('renders imperative toasts with variant styling', () => {
    const successId = toast({ variant: 'success', description: '连接成功，已同步 2 个模型' })
    const destructiveId = toast({ variant: 'destructive', description: '连接失败' })

    const html = renderToStaticMarkup(<Toaster />)
    expect(html).toContain('连接成功，已同步 2 个模型')
    expect(html).toContain('连接失败')
    expect(html).toContain('aria-live="polite"')

    dismissToast(successId)
    dismissToast(destructiveId)
    const cleared = renderToStaticMarkup(<Toaster />)
    expect(cleared).not.toContain('连接成功，已同步 2 个模型')
    expect(cleared).not.toContain('连接失败')
  })

  it('renders the shared LinX-style login building blocks', () => {
    const shell = renderToStaticMarkup(
      <LoginCardShell ariaLabel="登录 Xpod">
        <LoginRestoringView accountName="Alice" label="正在恢复登录状态..." />
      </LoginCardShell>,
    )
    expect(shell).toContain('aria-label="登录 Xpod"')
    expect(shell).toContain('data-login-card-size="compact"')
    expect(shell).toContain('Alice')
    expect(shell).toContain('正在恢复登录状态...')

    const providerList = renderToStaticMarkup(
      <LoginProviderListView
        providers={[{
          id: 'https://xpod.local',
          label: '当前 Xpod',
          subtitle: 'xpod.local',
          badge: { label: '本机', tone: 'primary' },
          actionLabel: '登录',
        }]}
        onConnect={() => undefined}
        onAddProvider={() => undefined}
      />,
    )
    expect(providerList).toContain('当前 Xpod')
    expect(providerList).toContain('本机')
    expect(providerList).toContain('xpod.local')
    expect(providerList).toContain('添加登录方式')

    const account = renderToStaticMarkup(
      <LoginAccountView
        name="Alice"
        bindingLabel="https://xpod.local"
        expired
        expiredDescription="为保护数据，会话已暂停。"
        onEnter={() => undefined}
        onSwitchAccount={() => undefined}
      />,
    )
    expect(account).toContain('会话已过期')
    expect(account).toContain('为保护数据，会话已暂停。')
    expect(account).toContain('切换账号')
  })

  it('renders the login failure and storage conflict views from the LinX login flow', () => {
    const failure = renderToStaticMarkup(
      <LoginFailureView
        description="native clients require End-User interaction"
        primaryLabel="重试云端登录"
        onPrimary={() => undefined}
        secondaryLabel="重新登录"
        onSecondary={() => undefined}
      />,
    )
    expect(failure).toContain('登录未完成')
    expect(failure).toContain('native clients require End-User interaction')
    expect(failure).toContain('重试云端登录')
    expect(failure).toContain('重新登录')

    const conflict = renderToStaticMarkup(
      <LoginStorageConflictView
        eyebrow="空间不匹配"
        accountName="LinX 用户"
        description="当前账号绑定的是另一个空间。"
        expectedValue="https://id.undefineds.co/glocal/"
        actualValue="https://node-0000.undefineds.co/glocal/"
        secondaryLabel="返回登录并重新选择空间"
        onSecondary={() => undefined}
      />,
    )
    expect(conflict).toContain('空间不匹配')
    expect(conflict).toContain('当前空间应写入')
    expect(conflict).toContain('https://id.undefineds.co/glocal/')
    expect(conflict).toContain('账号当前绑定')
    expect(conflict).toContain('返回登录并重新选择空间')
  })
})

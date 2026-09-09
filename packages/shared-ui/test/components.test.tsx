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
  LoginErrorBanner,
  LoginFailureView,
  LoginRestoringView,
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

  it('renders the shared login building blocks', () => {
    const shell = renderToStaticMarkup(
      <LoginCardShell ariaLabel="登录">
        <LoginRestoringView accountName="Alice" label="正在恢复登录状态..." />
      </LoginCardShell>,
    )
    expect(shell).toContain('data-login-card-size="compact"')
    expect(shell).toContain('role="dialog"')
    expect(shell).toContain('aria-label="登录"')
    expect(shell).toContain('Alice')
    expect(shell).toContain('正在恢复登录状态...')

    const account = renderToStaticMarkup(
      <LoginAccountView
        name="Alice"
        bindingLabel="https://xpod.local"
        expired
        expiredTitle="Host session ended"
        expiredDescription="为保护数据，会话已暂停。"
        enterLabel="Enter"
        switchLabel="Switch account"
        onEnter={() => undefined}
        onSwitchAccount={() => undefined}
      />,
    )
    expect(account).toContain('Host session ended')
    expect(account).not.toContain('Session expired')
    expect(account).toContain('为保护数据，会话已暂停。')
    expect(account).toContain('Switch account')
  })

  it('renders a WeChat-style remembered account view without credential or provider choices', () => {
    const html = renderToStaticMarkup(
      <LoginAccountView
        name="Alice Zhang"
        bindingLabel="alice@example.test"
        expired
        expiredTitle="Sign in again"
        expiredDescription="Verify this remembered Xpod account to continue."
        enterLabel="Log in again"
        switchLabel="Use another account"
        onEnter={() => undefined}
        onSwitchAccount={() => undefined}
      />,
    )

    expect(html).toContain('Alice Zhang')
    expect(html).toContain('alice@example.test')
    expect(html).toContain('>A<')
    expect(html).toContain('Log in again')
    expect(html).toContain('Use another account')
    expect(html).toContain('rounded-[18%]')
    expect(html).toContain('h-10 w-full')
    expect(html).toContain('rounded-xl bg-primary')
    expect(html).not.toContain('type="email"')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('role="textbox"')
    expect(html).not.toContain('Add sign-in method')
    expect(html).not.toContain('More options')
    expect(html).not.toContain('Use method')
  })

  it('renders the login failure view with host-supplied copy', () => {
    const failure = renderToStaticMarkup(
      <LoginFailureView
        title="Sign-in incomplete"
        description="native clients require End-User interaction"
        primaryLabel="Retry sign-in"
        onPrimary={() => undefined}
        secondaryLabel="Start over"
        onSecondary={() => undefined}
      />,
    )
    expect(failure).toContain('Sign-in incomplete')
    expect(failure).toContain('native clients require End-User interaction')
    expect(failure).toContain('Retry sign-in')
    expect(failure).toContain('Start over')
  })

  it('keeps neutral defaults when host copy is omitted', () => {
    const account = renderToStaticMarkup(
      <LoginAccountView
        name="User"
        onEnter={() => undefined}
      />,
    )
    expect(account).toContain('Continue')

    const error = renderToStaticMarkup(
      <LoginErrorBanner
        error="Something went wrong"
        onDismiss={() => undefined}
      />,
    )
    expect(error).toContain('aria-label="Dismiss"')
  })

  it('keeps the expired indicator visible when hosts omit its label', () => {
    const html = renderToStaticMarkup(
      <LoginAccountView
        name="User"
        expired
        onEnter={() => undefined}
      />,
    )

    expect(html).toContain('Session expired')
  })

  it('uses every complete host copy field without mixing in defaults', () => {
    const html = renderToStaticMarkup(
      <>
        <LoginAccountView
          name="User"
          enterLabel="Host enter"
          error="Host account error"
          onDismissError={() => undefined}
          dismissErrorLabel="Host account dismiss"
          onEnter={() => undefined}
        />
        <LoginErrorBanner
          error="Host error"
          onDismiss={() => undefined}
          dismissLabel="Host dismiss"
        />
      </>,
    )

    expect(html).toContain('Host enter')
    expect(html).toContain('Host dismiss')
    expect(html).toContain('Host account dismiss')
    expect(html).not.toContain('aria-label="Dismiss"')
  })
})

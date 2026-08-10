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
  LoginProviderListView,
  LoginRestoringView,
  LoginSpaceSelectionView,
  LoginStorageConflictView,
  SolidConnectForm,
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
        copy={{
          title: 'More options', backLabel: 'Back', addLabel: 'Add sign-in method', addPlaceholder: 'https://pod.example.com',
          addInputLabel: 'Sign-in method address', invalidUrlMessage: 'Enter a valid URL.', connectLabel: 'Connect', cancelLabel: 'Cancel', emptyMessage: 'No sign-in methods',
        }}
      />,
    )
    expect(providerList).toContain('当前 Xpod')
    expect(providerList).toContain('本机')
    expect(providerList).toContain('xpod.local')
    expect(providerList).toContain('Add sign-in method')

    const account = renderToStaticMarkup(
      <LoginAccountView
        name="Alice"
        bindingLabel="https://xpod.local"
        expired
        expiredTitle="Session expired"
        expiredDescription="为保护数据，会话已暂停。"
        enterLabel="Enter"
        switchLabel="Switch account"
        onEnter={() => undefined}
        onSwitchAccount={() => undefined}
      />,
    )
    expect(account).toContain('Session expired')
    expect(account).toContain('为保护数据，会话已暂停。')
    expect(account).toContain('Switch account')
  })

  it('renders the login failure and storage conflict views from the LinX login flow', () => {
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

    const conflict = renderToStaticMarkup(
      <LoginStorageConflictView
        eyebrow="Space mismatch"
        accountName="Northstar user"
        description="The account is bound to another space."
        expectedLabel="Expected space"
        expectedValue="https://id.example.test/space/"
        actualLabel="Bound space"
        actualValue="https://node.example.test/space/"
        secondaryLabel="Return and choose again"
        onSecondary={() => undefined}
      />,
    )
    expect(conflict).toContain('Space mismatch')
    expect(conflict).toContain('Expected space')
    expect(conflict).toContain('https://id.example.test/space/')
    expect(conflict).toContain('Bound space')
    expect(conflict).toContain('Return and choose again')
  })

  it('renders host-supplied compatibility copy without product fallbacks', () => {
    const html = renderToStaticMarkup(
      <>
        <LoginSpaceSelectionView
          productName="Northstar"
          providers={{ cloud: { id: 'cloud-id', label: 'Remote space' }, local: { id: 'local-id', label: 'Desk space' } }}
          onConnect={() => undefined}
          copy={{
            accountLabel: 'Use your Northstar account', storageLabel: 'Storage location', cloudLabel: 'Remote', localLabel: 'Desk',
            cloudDescription: 'Keep data with your team.', localDescription: 'Keep data on this device.', continueLabel: 'Continue', moreProvidersLabel: 'More account options',
          }}
        />
        <SolidConnectForm onConnect={() => undefined} copy={{
          issuerLabel: 'Identity endpoint', issuerPlaceholder: 'https://identity.example.test', submitLabel: 'Continue', pendingLabel: 'Working…', errorMessage: 'Could not connect',
        }} />
      </>,
    )
    expect(html).toContain('Use your Northstar account')
    expect(html).toContain('Identity endpoint')
    expect(html).not.toContain('Xpod')
    expect(html).not.toContain('undefineds')
    expect(html).not.toContain('Cloud')
    expect(html).not.toContain('Local')
  })

  it('keeps legacy controls available with neutral defaults when copy is omitted', () => {
    const connect = renderToStaticMarkup(<SolidConnectForm onConnect={() => undefined} />)
    expect(connect).toContain('Identity provider URL')
    expect(connect).toContain('Connect')

    const space = renderToStaticMarkup(
      <LoginSpaceSelectionView
        productName="Northstar"
        providers={{ cloud: { id: 'cloud-id', label: 'Remote' }, local: { id: 'local-id', label: 'Local' } }}
        onConnect={() => undefined}
        onMoreProviders={() => undefined}
      />,
    )
    expect(space).toContain('Account')
    expect(space).toContain('Storage')
    expect(space).toContain('Remote')
    expect(space).toContain('Local')
    expect(space).toContain('Continue')
    expect(space).toContain('More options')

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

    const providers = renderToStaticMarkup(
      <LoginProviderListView
        providers={[]}
        onConnect={() => undefined}
        onAddProvider={() => undefined}
      />,
    )
    expect(providers).toContain('Add provider')

    const conflict = renderToStaticMarkup(
      <LoginStorageConflictView
        eyebrow="Mismatch"
        accountName="User"
        description="Mismatch"
        expectedLabel="Expected"
        expectedValue="expected"
        actualLabel="Actual"
        actualValue="actual"
        onSecondary={() => undefined}
      />,
    )
    expect(conflict).toContain('Return')
  })

  it('uses every complete host copy field without mixing in legacy defaults', () => {
    const html = renderToStaticMarkup(
      <>
        <SolidConnectForm
          onConnect={() => undefined}
          copy={{
            issuerLabel: 'Endpoint label',
            issuerPlaceholder: 'Endpoint placeholder',
            submitLabel: 'Submit endpoint',
            pendingLabel: 'Waiting endpoint',
            errorMessage: 'Endpoint error',
          }}
        />
        <LoginSpaceSelectionView
          productName="Host product"
          providers={{ cloud: { id: 'cloud-id', label: 'Remote choice' }, local: { id: 'local-id', label: 'Local choice' } }}
          error="Host space error"
          onConnect={() => undefined}
          onMoreProviders={() => undefined}
          onDismissError={() => undefined}
          copy={{
            accountLabel: 'Host account',
            storageLabel: 'Host storage',
            cloudLabel: 'Host remote',
            localLabel: 'Host local',
            cloudDescription: 'Host remote description',
            localDescription: 'Host local description',
            continueLabel: 'Host continue',
            moreProvidersLabel: 'Host more',
            dismissErrorLabel: 'Host space dismiss',
          }}
        />
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
        <LoginProviderListView
          providers={[]}
          error="Host provider error"
          onConnect={() => undefined}
          onAddProvider={() => undefined}
          onDismissError={() => undefined}
          copy={{
            title: 'Host providers',
            backLabel: 'Host back',
            addLabel: 'Host add',
            addPlaceholder: 'Host placeholder',
            addInputLabel: 'Host input',
            invalidUrlMessage: 'Host invalid URL',
            connectLabel: 'Host connect',
            cancelLabel: 'Host cancel',
            emptyMessage: 'Host empty',
            dismissErrorLabel: 'Host provider dismiss',
          }}
        />
      </>,
    )

    expect(html).toContain('Endpoint label')
    expect(html).toContain('Host remote')
    expect(html).toContain('Host enter')
    expect(html).toContain('Host dismiss')
    expect(html).toContain('Host space dismiss')
    expect(html).toContain('Host account dismiss')
    expect(html).toContain('Host provider dismiss')
    expect(html).toContain('Host add')
    expect(html).not.toContain('Identity provider URL')
    expect(html).not.toContain('More options')
    expect(html).not.toContain('Add provider')
    expect(html).not.toContain('aria-label="Dismiss"')
  })
})

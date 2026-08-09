// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthBoundary, LoginView } from '../src/react'

describe('AuthBoundary', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders children for authenticated state without invoking login', () => {
    const login = vi.fn()

    render(
      <AuthBoundary state={{ status: 'authenticated' }} login={login}>
        <section aria-label="Private workspace">Secret</section>
      </AuthBoundary>,
    )

    expect(screen.getByRole('region', { name: 'Private workspace' })).toBeTruthy()
    expect(login).not.toHaveBeenCalled()
  })

  it('renders a reusable issuer login surface for anonymous state', () => {
    const login = vi.fn()

    render(
      <AuthBoundary
        state={{ status: 'anonymous' }}
        login={login}
        loginView={{
          title: 'Connect Solid Pod',
          description: 'Use the issuer selected by the host.',
          defaultIssuer: ' https://solid.example.com ',
        }}
      >
        <section>Private workspace</section>
      </AuthBoundary>,
    )

    expect(screen.getByRole('heading', { name: 'Connect Solid Pod' })).toBeTruthy()
    expect(screen.getByText('Use the issuer selected by the host.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Solid Pod 地址'), {
      target: { value: ' https://issuer.example.org ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    expect(login).toHaveBeenCalledWith('https://issuer.example.org')
    expect(screen.queryByText('Private workspace')).toBeNull()
  })

  it('disables login when the issuer is blank', () => {
    const login = vi.fn()

    render(<LoginView title="Connect Solid Pod" onLogin={login} />)

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '连接' }).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Solid Pod 地址'), {
      target: { value: '   ' },
    })

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '连接' }).disabled).toBe(true)
    expect(login).not.toHaveBeenCalled()
  })

  it('shows an accessible progress status while authentication is loading', () => {
    const login = vi.fn()

    render(
      <AuthBoundary state={{ status: 'loading' }} login={login}>
        <section>Private workspace</section>
      </AuthBoundary>,
    )

    expect(screen.getByRole('status').textContent).toContain('正在检查登录状态')
    expect(login).not.toHaveBeenCalled()
  })

  it('shows the host-provided error in a dedicated failure view and still allows retrying login', () => {
    const login = vi.fn()

    const { rerender } = render(
      <AuthBoundary
        state={{ status: 'error', message: 'Pod host rejected the issuer.' }}
        login={login}
        loginView={{ title: 'Reconnect Pod', defaultIssuer: 'https://solid.example.com' }}
      >
        <section>Private workspace</section>
      </AuthBoundary>,
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Pod host rejected the issuer.')
    expect(alert.textContent).not.toContain('Internal Server Error')
    expect(screen.getByText('登录未完成')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    expect(login).toHaveBeenCalledWith('https://solid.example.com')

    fireEvent.click(screen.getByRole('button', { name: '重新选择登录方式' }))
    expect(screen.getByLabelText('Solid Pod 地址')).toBeTruthy()

    rerender(
      <AuthBoundary
        state={{ status: 'error', message: 'Pod host rejected the issuer.' }}
        login={login}
        loginView={{ title: 'Reconnect Pod', defaultIssuer: 'https://solid.example.com' }}
      >
        <section>Private workspace</section>
      </AuthBoundary>,
    )
    expect(screen.getByLabelText('Solid Pod 地址')).toBeTruthy()
  })

  it('renders the shared provider list login and connects through the selected provider', () => {
    const login = vi.fn()

    render(
      <AuthBoundary
        state={{ status: 'anonymous' }}
        login={login}
        loginView={{
          title: '登录 Xpod 设置',
          providers: [{
            id: 'https://xpod.local',
            label: '当前 Xpod',
            subtitle: 'xpod.local',
            badge: { label: '本机', tone: 'primary' },
            actionLabel: '登录',
          }],
          onAddProvider: (url) => void login(url),
        }}
      >
        <section>Private workspace</section>
      </AuthBoundary>,
    )

    expect(screen.getByText('当前 Xpod')).toBeTruthy()
    expect(screen.getByText('本机')).toBeTruthy()
    expect(screen.queryByLabelText('Solid Pod 地址')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /当前 Xpod/ }))
    expect(login).toHaveBeenCalledWith('https://xpod.local')
  })

  it('renders the Linx cloud/local chooser when the host supplies account spaces', () => {
    const login = vi.fn()

    render(
      <AuthBoundary
        state={{ status: 'anonymous' }}
        login={login}
        loginView={{
          title: 'Xpod',
          spaceProviders: {
            cloud: { id: 'https://id.undefineds.co', label: 'Cloud' },
            local: { id: 'https://xpod.local', label: 'Local' },
          },
          onAddProvider: (url) => void login(url),
        }}
      >
        <section>Private workspace</section>
      </AuthBoundary>,
    )

    expect(screen.getByText('使用 undefineds 账号')).toBeTruthy()
    expect(screen.getByRole('button', { name: '云端' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '本机' })).toBeTruthy()
    expect(screen.queryByLabelText('Solid Pod 地址')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '本机' }))
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(login).toHaveBeenCalledWith('https://xpod.local')
  })

  it('adds a custom login provider through the shared add form with URL validation', () => {
    const login = vi.fn()

    render(
      <AuthBoundary
        state={{ status: 'anonymous' }}
        login={login}
        loginView={{
          title: '登录 Xpod 设置',
          providers: [],
          onAddProvider: (url) => void login(url),
        }}
      >
        <section>Private workspace</section>
      </AuthBoundary>,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加登录方式' }))

    const input = screen.getByLabelText('登录方式地址')
    fireEvent.change(input, { target: { value: 'not a url' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(screen.getByRole('alert').textContent).toContain('请输入有效的 http(s) 地址。')
    expect(login).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'pod.example.org' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(login).toHaveBeenCalledWith('https://pod.example.org')
  })
})

describe('LoginView', () => {
  afterEach(() => {
    cleanup()
  })

  it('disables the form while async login is pending and prevents duplicate submits', async () => {
    let finishLogin: (() => void) | undefined
    const login = vi.fn(() => new Promise<void>((resolve) => {
      finishLogin = resolve
    }))

    render(
      <LoginView
        title="Connect Solid Pod"
        defaultIssuer="https://solid.example.com"
        onLogin={login}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    fireEvent.click(screen.getByRole('button', { name: '连接中...' }))

    expect(login).toHaveBeenCalledTimes(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '连接中...' }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Solid Pod 地址').disabled).toBe(true)

    finishLogin?.()

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '连接' }).disabled).toBe(false)
    })
  })

  it.each([
    {
      name: 'Error message',
      rejection: new Error('token=secret'),
      leakedText: 'token=secret',
    },
    {
      name: 'string rejection',
      rejection: 'Internal Server Error: token=secret',
      leakedText: 'Internal Server Error: token=secret',
    },
    {
      name: 'plain object',
      rejection: { message: 'token=secret', token: 'secret-token' },
      leakedText: 'secret-token',
    },
  ])('normalizes rejected login $name without leaking raw details', async ({
    rejection,
    leakedText,
  }) => {
    const login = vi.fn(async () => {
      throw rejection
    })

    render(
      <LoginView
        title="Connect Solid Pod"
        defaultIssuer="https://solid.example.com"
        onLogin={login}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('登录失败，请重试。')
    expect(alert.textContent).not.toContain(leakedText)
    expect(alert.textContent).not.toContain('Internal Server Error')
  })
})

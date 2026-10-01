// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConsentView,
  IdpNoWebIdView,
  IdpRegisterView,
  IdpSignInView,
  type ConsentViewProps,
} from '../src'

afterEach(() => cleanup())

const service = { serviceName: 'Xpod', serviceHost: 'pod.undefineds.co' }

describe('IdpSignInView (B1)', () => {
  function renderView(overrides: Partial<Parameters<typeof IdpSignInView>[0]> = {}) {
    const handlers = {
      onRememberChange: vi.fn(),
      onSubmit: vi.fn(),
      onForgot: vi.fn(),
      onRegister: vi.fn(),
      onUseOtherSolid: vi.fn(),
    }
    render(<IdpSignInView {...service} returnToAppName="Northstar" remember={false} {...handlers} {...overrides} />)
    return handlers
  }

  it('names the service in the top bar and the only heading, and where you return to', () => {
    renderView()
    expect(screen.getByText('Xpod · 账号服务')).toBeTruthy()
    expect(screen.getByText('pod.undefineds.co')).toBeTruthy()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: '登录 Xpod' })).toBeTruthy()
    expect(screen.getByText('完成后回到 Northstar')).toBeTruthy()
  })

  it('submits trimmed email and password and wires the secondary actions', () => {
    const handlers = renderView()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: ' ari@example.com ' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'hunter2!' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(handlers.onSubmit).toHaveBeenCalledWith({ email: 'ari@example.com', password: 'hunter2!' })

    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }))
    fireEvent.click(screen.getByRole('button', { name: '注册账号' }))
    fireEvent.click(screen.getByRole('button', { name: '使用其他 Solid 账号' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '在这台设备上保持登录' }))
    expect(handlers.onForgot).toHaveBeenCalledTimes(1)
    expect(handlers.onRegister).toHaveBeenCalledTimes(1)
    expect(handlers.onUseOtherSolid).toHaveBeenCalledTimes(1)
    expect(handlers.onRememberChange).toHaveBeenCalledWith(true)
  })

  it('keeps "remember this device" unchecked by default when the host says so', () => {
    renderView({ remember: false })
    expect((screen.getByRole('checkbox', { name: '在这台设备上保持登录' }) as HTMLInputElement).checked).toBe(false)
  })

  it('hides the remember choice when the host does not offer one, and reports field edits', () => {
    const onFieldChange = vi.fn()
    renderView({ onRememberChange: undefined, onFieldChange })
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } })
    expect(onFieldChange).toHaveBeenCalledWith('email', 'a@b.c')
    expect(onFieldChange).toHaveBeenCalledWith('password', 'pw')
  })

  it('shows field errors under their fields and a form error as an alert', () => {
    renderView({ error: '邮箱或密码不正确。', fieldErrors: { email: '请输入邮箱' } })
    const email = screen.getByLabelText('邮箱')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent)
    expect(alerts).toEqual(expect.arrayContaining(['邮箱或密码不正确。', '请输入邮箱']))
    expect(email.getAttribute('aria-describedby')).toBeTruthy()
  })

  it('spins and locks the form while pending', () => {
    const handlers = renderView({ pending: true })
    const button = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.submit(button.closest('form')!)
    expect(handlers.onSubmit).not.toHaveBeenCalled()
  })

  it('omits the other-Solid link when the host does not offer it, and speaks English', () => {
    renderView({ onUseOtherSolid: undefined, locale: 'en' })
    expect(screen.queryByRole('button', { name: /Solid/ })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Xpod' })).toBeTruthy()
    expect(screen.getByText('Xpod · Sign-in service')).toBeTruthy()
  })
})

describe('IdpRegisterView (B2)', () => {
  it('previews the WebID and Pod, requires username when told to, and submits', () => {
    const onSubmit = vi.fn()
    const onSignIn = vi.fn()
    const onFieldChange = vi.fn()
    render(
      <IdpRegisterView
        {...service}
        returnToAppName="Northstar"
        requireUsername
        usernamePreview="将创建你的 WebID 和 Pod：pod.undefineds.co/xiaolin/"
        onFieldChange={onFieldChange}
        onSubmit={onSubmit}
        onSignIn={onSignIn}
      />,
    )
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: '注册 Xpod' })).toBeTruthy()
    expect(screen.getByText(/pod\.undefineds\.co\/xiaolin\//)).toBeTruthy()
    // The Pod-on-my-computer explanation is folded.
    expect(screen.getByText('想用你自己的独立部署存放 Pod？').closest('details')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'xiaolin' } })
    expect(onFieldChange).toHaveBeenCalledWith('username', 'xiaolin')
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'x@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByRole('button', { name: '注册' }))
    expect(onSubmit).toHaveBeenCalledWith({ username: 'xiaolin', email: 'x@example.com', password: 'secret-pass' })

    fireEvent.click(screen.getByRole('button', { name: '已有账号？登录' }))
    expect(onSignIn).toHaveBeenCalledTimes(1)
  })

  it('omits the username field when the controls do not ask for one', () => {
    const onSubmit = vi.fn()
    render(<IdpRegisterView {...service} requireUsername={false} onSubmit={onSubmit} onSignIn={() => undefined} />)
    expect(screen.queryByLabelText('用户名')).toBeNull()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'x@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByRole('button', { name: '注册' }))
    expect(onSubmit).toHaveBeenCalledWith({ email: 'x@example.com', password: 'secret-pass' })
  })

  it('shows field errors inline and locks while pending', () => {
    render(
      <IdpRegisterView
        {...service}
        requireUsername
        pending
        fieldErrors={{ username: '用户名已被占用' }}
        onSubmit={() => undefined}
        onSignIn={() => undefined}
      />,
    )
    expect(screen.getByRole('alert').textContent).toBe('用户名已被占用')
    expect(screen.getByLabelText('用户名').getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByRole('button', { name: '注册' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('IdpNoWebIdView (B3)', () => {
  function renderView(overrides: Partial<Parameters<typeof IdpNoWebIdView>[0]> = {}) {
    const onCreate = vi.fn()
    const onChooseOtherLocation = vi.fn()
    const onNameChange = vi.fn()
    render(
      <IdpNoWebIdView
        {...service}
        appName="Northstar"
        defaultName="ari"
        onCreate={onCreate}
        onNameChange={onNameChange}
        onChooseOtherLocation={onChooseOtherLocation}
        {...overrides}
      />,
    )
    return { onCreate, onChooseOtherLocation, onNameChange }
  }

  it('prefills the name, creates and continues, or leaves for the account page', () => {
    const { onCreate, onChooseOtherLocation, onNameChange } = renderView()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: '还没有 WebID' })).toBeTruthy()
    expect(screen.getByText(/登录 Northstar/)).toBeTruthy()
    const input = screen.getByLabelText('WebID 名称') as HTMLInputElement
    expect(input.value).toBe('ari')
    fireEvent.change(input, { target: { value: 'ari2' } })
    expect(onNameChange).toHaveBeenCalledWith('ari2')
    fireEvent.click(screen.getByRole('button', { name: '创建并继续' }))
    expect(onCreate).toHaveBeenCalledWith('ari2')
    fireEvent.click(screen.getByRole('button', { name: '存到边缘设备（打开账号页）' }))
    expect(onChooseOtherLocation).toHaveBeenCalledTimes(1)
  })

  it('announces availability politely and blocks creating a taken name assertively', () => {
    const { rerender } = render(
      <IdpNoWebIdView
        {...service}
        appName="Northstar"
        defaultName="ari"
        nameHint={{ tone: 'ok', text: '名称可用' }}
        onCreate={() => undefined}
        onChooseOtherLocation={() => undefined}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('名称可用')

    const onCreate = vi.fn()
    rerender(
      <IdpNoWebIdView
        {...service}
        appName="Northstar"
        defaultName="ari"
        nameHint={{ tone: 'error', text: '名称已被占用' }}
        onCreate={onCreate}
        onChooseOtherLocation={() => undefined}
      />,
    )
    expect(screen.getByRole('alert').textContent).toBe('名称已被占用')
    const create = screen.getByRole('button', { name: '创建并继续' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.submit(create.closest('form')!)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('without a name field it only continues, and hides the other-location action when not offered', () => {
    const onCreate = vi.fn()
    render(<IdpNoWebIdView {...service} appName="Northstar" defaultName={undefined} onCreate={onCreate} />)
    expect(screen.queryByLabelText('WebID 名称')).toBeNull()
    expect(screen.queryByRole('button', { name: '存到边缘设备（打开账号页）' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '创建并继续' }))
    expect(onCreate).toHaveBeenCalledWith('')
  })

  it('is busy on create while pending', () => {
    renderView({ pending: true })
    expect((screen.getByRole('button', { name: '创建并继续' }) as HTMLButtonElement).getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: '存到边缘设备（打开账号页）' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ConsentView (B4)', () => {
  const webIds: ConsentViewProps['webIds'] = [
    { id: 'a', displayName: 'Ari', shortName: 'pod.undefineds.co/ari', storage: { kind: 'cloud', label: '数据存在 Xpod 云端' } },
    { id: 'b', displayName: 'Ari Home', shortName: 'node-7f3a.undefineds.co/ari', storage: { kind: 'edge', label: '数据存在这台电脑上' } },
  ]

  function renderConsent(overrides: Partial<ConsentViewProps> = {}) {
    const handlers = {
      onSelectWebId: vi.fn(),
      onRememberChange: vi.fn(),
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    }
    render(
      <ConsentView
        {...service}
        app={{ name: 'Northstar', host: 'northstar.example', clientId: 'https://northstar.example/id', verified: true }}
        webIds={webIds}
        selectedWebId="a"
        scopes={[{ id: 'read', label: '读取你的数据' }]}
        rememberChoice={false}
        {...handlers}
        {...overrides}
      />,
    )
    return handlers
  }

  it('keeps three roles in fixed places: service bar, app title, WebID list', () => {
    renderConsent()
    expect(screen.getByText('Xpod · 账号服务')).toBeTruthy()
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: '授权 Northstar' })).toBeTruthy()
    expect(screen.getByText('northstar.example')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '用哪个 WebID 登录？' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '数据存在 Xpod 云端' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '数据存在这台电脑上' })).toBeTruthy()
    expect(screen.getByText(/Northstar 将以这个身份读写你的数据/)).toBeTruthy()
  })

  it('selects a WebID with the radio group and calls approve and deny', () => {
    const handlers = renderConsent()
    expect((screen.getByRole('radio', { name: /Ari Home/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('radio', { name: /Ari pod\.undefineds/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /Ari Home/ }))
    expect(handlers.onSelectWebId).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(handlers.onApprove).toHaveBeenCalledTimes(1)
    expect(handlers.onDeny).toHaveBeenCalledTimes(1)
  })

  it('shows one row and no radio for a single WebID', () => {
    renderConsent({ webIds: [webIds[0]!] })
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('Ari')).toBeTruthy()
  })

  it('folds the request details, including scope, client id and "do not ask again"', () => {
    const handlers = renderConsent()
    const details = screen.getByText('请求详情').closest('details')!
    expect(details).not.toBeNull()
    expect(within(details).getByText('读取你的数据')).toBeTruthy()
    expect(within(details).getByText('https://northstar.example/id')).toBeTruthy()
    fireEvent.click(within(details).getByRole('checkbox', { name: '以后不再询问' }))
    expect(handlers.onRememberChange).toHaveBeenCalledWith(true)
  })

  it('warns about an unverified client and removes "do not ask again"', () => {
    renderConsent({ app: { name: 'Northstar', host: 'northstar.example', verified: false } })
    expect(screen.getByRole('alert').textContent).toContain('未能验证')
    expect(screen.queryByRole('checkbox', { name: '以后不再询问' })).toBeNull()
  })

  it('spins only the chosen button while pending and disables both', () => {
    renderConsent({ pending: 'approve' })
    const allow = screen.getByRole('button', { name: '允许' }) as HTMLButtonElement
    const deny = screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    expect(deny.disabled).toBe(true)
    expect(allow.getAttribute('aria-busy')).toBe('true')
    expect(deny.getAttribute('aria-busy')).toBeNull()
  })

  it('mirrors the choice in a hidden native select that automation can drive', () => {
    const handlers = renderConsent({ automationSelectId: 'oidc-consent-webid' })
    const select = document.getElementById('oidc-consent-webid') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.getAttribute('aria-hidden')).toBe('true')
    expect(select.value).toBe('a')
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['a', 'b'])
    fireEvent.change(select, { target: { value: 'b' } })
    expect(handlers.onSelectWebId).toHaveBeenCalledWith('b')
  })

  it('has no automation select for a single WebID', () => {
    renderConsent({ webIds: [webIds[0]!], automationSelectId: 'oidc-consent-webid' })
    expect(document.getElementById('oidc-consent-webid')).toBeNull()
  })

  it('disables Allow while nothing is chosen, and every action while another operation runs', () => {
    renderConsent({ approveDisabled: true })
    expect((screen.getByRole('button', { name: '允许' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    renderConsent({ disabled: true })
    expect((screen.getByRole('button', { name: '允许' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers manage and switch account when the host wires them', () => {
    const onManageAccount = vi.fn()
    const onSwitchAccount = vi.fn()
    renderConsent({ onManageAccount, onSwitchAccount })
    fireEvent.click(screen.getByRole('button', { name: '管理账号' }))
    fireEvent.click(screen.getByRole('button', { name: '换一个账号' }))
    expect(onManageAccount).toHaveBeenCalledTimes(1)
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })
})

describe('screen layout', () => {
  it('pins the action area outside the scrolling main area and makes the service bar a flat full-width strip', () => {
    render(<IdpSignInView serviceName="Xpod" serviceHost="pod.undefineds.co" remember={false} onSubmit={() => undefined} />)
    const main = document.querySelector('[data-pod-sign-in="main"]') as HTMLElement
    const actions = document.querySelector('[data-pod-sign-in="actions"]') as HTMLElement
    expect(main.className).toContain('overflow-y-auto')
    expect(actions.className).toContain('shrink-0')
    expect(main.contains(actions)).toBe(false)
    expect(actions.contains(screen.getByRole('button', { name: '登录' }))).toBe(true)
    const bar = document.querySelector('[data-pod-sign-in="idp-chrome"]') as HTMLElement
    expect(bar.className).toContain('h-11')
    expect(bar.className).toContain('border-b')
    expect(bar.className).not.toContain('rounded')
    expect(bar.className).toContain('px-4')
  })
})

describe('secondary actions never submit the form', () => {
  it('B1: register, forgot and other-Solid do not call onSubmit', () => {
    const onSubmit = vi.fn()
    render(
      <IdpSignInView {...service} remember={false} onSubmit={onSubmit} onRegister={() => undefined}
        onForgot={() => undefined} onUseOtherSolid={() => undefined} onRememberChange={() => undefined} />,
    )
    for (const name of ['注册账号', '忘记密码？', '使用其他 Solid 账号']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.type).toBe('button')
      fireEvent.click(button)
    }
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('B2 and B3: secondary actions are plain buttons and do not submit', () => {
    const onSubmit = vi.fn()
    const onCreate = vi.fn()
    const { unmount } = render(<IdpRegisterView {...service} requireUsername={false} onSubmit={onSubmit} onSignIn={() => undefined} />)
    const signIn = screen.getByRole('button', { name: '已有账号？登录' }) as HTMLButtonElement
    expect(signIn.type).toBe('button')
    fireEvent.click(signIn)
    expect(onSubmit).not.toHaveBeenCalled()
    unmount()
    render(<IdpNoWebIdView {...service} appName="Northstar" defaultName="ari" onCreate={onCreate} onChooseOtherLocation={() => undefined} />)
    const other = screen.getByRole('button', { name: '存到边缘设备（打开账号页）' }) as HTMLButtonElement
    expect(other.type).toBe('button')
    fireEvent.click(other)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('B4: manage, switch and deny do not approve', () => {
    const onApprove = vi.fn()
    render(
      <ConsentView {...service} app={{ name: 'Northstar', host: 'n.example', verified: true }}
        webIds={[{ id: 'a', displayName: 'Ari', shortName: 'x', storage: { kind: 'cloud', label: 'c' } }]}
        selectedWebId="a" scopes={[]} rememberChoice onSelectWebId={() => undefined} onRememberChange={() => undefined}
        onApprove={onApprove} onDeny={() => undefined} onManageAccount={() => undefined} onSwitchAccount={() => undefined} />,
    )
    for (const name of ['拒绝', '管理账号', '换一个账号']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.type).toBe('button')
      fireEvent.click(button)
    }
    expect(onApprove).not.toHaveBeenCalled()
  })
})

describe('ConsentView identity rows', () => {
  it('shows a short name, hides a duplicate of the name, and keeps the full WebID in the request details', () => {
    render(
      <ConsentView {...service} app={{ name: 'Northstar', host: 'n.example', verified: true }}
        webIds={[{ id: 'a', displayName: 'acceptml1', shortName: 'acceptml1', webId: 'https://node-1.nodes.example/acceptml1/profile/card#me',
          storage: { kind: 'edge', label: 'e' } }]}
        selectedWebId="a" scopes={[]} rememberChoice onSelectWebId={() => undefined} onRememberChange={() => undefined}
        onApprove={() => undefined} onDeny={() => undefined} />,
    )
    const row = document.querySelector('[data-pod-sign-in="webid-row"]') as HTMLElement
    expect(row.querySelectorAll('.font-mono')).toHaveLength(0)
    expect(row.textContent).not.toContain('nodes.example')
    const details = screen.getByText('请求详情').closest('details')!
    expect(within(details).getByText('https://node-1.nodes.example/acceptml1/profile/card#me')).toBeTruthy()
  })
})

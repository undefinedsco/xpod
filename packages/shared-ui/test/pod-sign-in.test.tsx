// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IdpChrome,
  PodSignIn,
  PodSignInFrame,
  StorageBadge,
  type PodSignInProps,
} from '../src'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const app = { name: 'Northstar', icon: <svg data-testid="app-icon" /> }
const identity = {
  displayName: 'Ari Chen',
  storage: { kind: 'edge' as const, label: '数据存在这台电脑上' },
}

function renderSignIn(props: Partial<PodSignInProps> & Pick<PodSignInProps, 'state'>) {
  const onPrimary = vi.fn()
  const utils = render(<PodSignIn app={app} onPrimary={onPrimary} {...props} />)
  return { onPrimary, ...utils }
}

describe('PodSignInFrame', () => {
  it('renders the same body in window, page and inline dialog frames', () => {
    const body = <p>body</p>
    const { rerender } = render(<PodSignInFrame presentation="window" ariaLabel="登录">{body}</PodSignInFrame>)
    expect(screen.getByRole('region', { name: '登录' }).getAttribute('data-pod-sign-in-frame')).toBe('window')
    expect(screen.getByText('body')).toBeTruthy()

    rerender(
      <PodSignInFrame presentation="page" ariaLabel="登录" appIntro={<p>intro</p>}>{body}</PodSignInFrame>,
    )
    expect(screen.getByRole('region', { name: '登录' }).getAttribute('data-pod-sign-in-frame')).toBe('page')
    expect(screen.getByText('intro')).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()

    rerender(<PodSignInFrame presentation="dialog" modal={false} ariaLabel="登录">{body}</PodSignInFrame>)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('keeps the account-service introduction in the page frame, and drops the second column without one', () => {
    const { rerender } = render(
      <PodSignInFrame presentation="page" ariaLabel="登录" appIntro={<p>账号服务介绍</p>}>
        <p>body</p>
      </PodSignInFrame>,
    )
    const frame = screen.getByRole('region', { name: '登录' })
    // Wide screens: two columns, intro on a sunken panel.
    expect(frame.className).toContain('md:grid-cols-2')
    const intro = frame.querySelector('[data-pod-sign-in="intro"]') as HTMLElement
    expect(intro).toBeTruthy()
    expect(intro.className).toContain('bg-[hsl(var(--sunken))]')
    expect(frame.querySelector('[data-pod-sign-in="intro"]')?.textContent).toContain('账号服务介绍')
    // Narrow screens: the intro column collapses, the body stays a single 360 column.
    expect(intro.className).toContain('hidden')
    expect(frame.querySelector('.md\\:col-span-2')).toBeNull()
    rerender(<PodSignInFrame presentation="page" ariaLabel="登录"><p>body</p></PodSignInFrame>)
    expect(screen.queryByText('账号服务介绍')).toBeNull()
    expect(screen.getByText('body').parentElement?.parentElement?.className).toContain('md:col-span-2')
  })

  it('fills the host window instead of drawing a compact card', () => {
    render(<PodSignInFrame presentation="window" ariaLabel="登录 Xpod"><p>body</p></PodSignInFrame>)
    const frame = screen.getByRole('region', { name: '登录 Xpod' })
    expect(frame.className).toContain('h-full')
    expect(frame.className).toContain('w-full')
    expect(frame.className).toContain('min-w-0')
    expect(frame.className).toContain('min-h-0')
    expect(frame.className).not.toMatch(/min-[wh]-\[\d+px\]/)
    expect(frame.className).not.toMatch(/w-\[280px\]|h-\[400px\]/)
    expect(screen.getByText('body').parentElement?.className).toContain('max-w-[360px]')
  })

  it('makes the modal dialog own focus, close on Escape and trap Tab', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button">opener</button>
        <PodSignInFrame presentation="dialog" ariaLabel="登录" onClose={onClose}>
          <button type="button">first</button>
          <button type="button">last</button>
        </PodSignInFrame>
      </>,
    )
    const dialog = screen.getByRole('dialog', { name: '登录' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)

    screen.getByRole('button', { name: 'last' }).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }))
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'last' }))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('PodSignIn dialog focus (spec §5.1)', () => {
  function renderDialog(
    opts: { close?: boolean; state?: PodSignInProps['state']; onPrimary?: () => void } = {},
  ) {
    const onPrimary = opts.onPrimary ?? vi.fn()
    const onClose = vi.fn()
    const withClose = opts.close !== false
    const utils = render(
      <>
        <button type="button">opener</button>
        <PodSignInFrame
          presentation="dialog"
          ariaLabel="登录"
          onClose={withClose ? onClose : undefined}
          closeLabel={withClose ? '关闭登录' : undefined}
        >
          <PodSignIn app={app} state={opts.state ?? { kind: 'choose-service' }} onPrimary={onPrimary} />
        </PodSignInFrame>
      </>,
    )
    return { onPrimary, onClose, ...utils }
  }

  it('sends the first Tab to the enabled primary action, not the close button', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '登录' })
    expect(document.activeElement).toBe(dialog)

    fireEvent.keyDown(document, { key: 'Tab' })
    const primary = screen.getByRole('button', { name: '使用 Xpod 账号登录' }) as HTMLButtonElement
    expect(document.activeElement).toBe(primary)
    expect(primary.disabled).toBe(false)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '关闭登录' }))
  })

  it('still reaches the primary action first when the dialog has no close button', () => {
    renderDialog({ close: false })
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '登录' }))

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '使用 Xpod 账号登录' }))
    // The content disclosures stay keyboard reachable but are no longer the entry point.
    expect(document.activeElement).not.toBe(screen.getByText('什么是 WebID？'))
  })

  it('falls back inside the dialog when the primary is disabled, without trapping on it', () => {
    renderDialog({ state: { kind: 'choose-service', busy: true } })
    const dialog = screen.getByRole('dialog', { name: '登录' })
    const primary = screen.getByRole('button', { name: '使用 Xpod 账号登录' }) as HTMLButtonElement
    expect(primary.disabled).toBe(true)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).not.toBe(primary)
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Repeated Tab keeps cycling through real controls instead of dead-ending.
    fireEvent.keyDown(document, { key: 'Tab' })
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(primary)
  })

  it('keeps the rest of the trap intact: cycle, disclosures, Escape and opener restore', () => {
    const { onClose, unmount } = renderDialog()
    const dialog = screen.getByRole('dialog', { name: '登录' })
    const primary = screen.getByRole('button', { name: '使用 Xpod 账号登录' })

    fireEvent.keyDown(document, { key: 'Tab' })
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '使用其他 Solid 账号' }))
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(primary)

    // Disclosures remain in the keyboard order, ahead of the primary action.
    screen.getByText('什么是 WebID？').focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('什么是 Pod？'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    expect(dialog.contains(document.activeElement)).toBe(true)
    unmount()
  })

  it('returns focus to the opener when the dialog unmounts', () => {
    const { rerender } = render(<button type="button">opener</button>)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    rerender(
      <>
        <button type="button">opener</button>
        <PodSignInFrame presentation="dialog" ariaLabel="登录"><p>body</p></PodSignInFrame>
      </>,
    )
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '登录' }))
    rerender(<button type="button">opener</button>)
    expect(document.activeElement).toBe(opener)
  })
})

describe('PodSignIn dialog focus with a collapsed developer detail (spec §10)', () => {
  const notice = {
    tone: 'warning' as const,
    text: '暂时无法连接，请重试',
    primaryLabel: '重试',
    developerDetail: 'phase=callback code=state_mismatch',
  }

  function renderDeveloperDialog() {
    const onClose = vi.fn()
    const onPrimary = vi.fn()
    render(
      <PodSignInFrame presentation="dialog" ariaLabel="登录" onClose={onClose} closeLabel="关闭登录">
        <PodSignIn
          app={app}
          state={{ kind: 'choose-service' }}
          notice={notice}
          developerMode
          onPrimary={onPrimary}
          onRegister={vi.fn()}
        />
      </PodSignInFrame>,
    )
    return { onClose, onPrimary }
  }

  const tab = () => fireEvent.keyDown(document, { key: 'Tab' })
  const shiftTab = () => fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })

  it('skips the collapsed detail instead of dead-ending on its hidden copy button', () => {
    renderDeveloperDialog()
    const primary = screen.getByRole('button', { name: '重试' })
    const noticeSummary = screen.getByText('暂时无法连接，请重试').closest('summary') as HTMLElement
    // The copy action is in the DOM, but hidden while the detail is collapsed.
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()

    tab()
    expect(document.activeElement).toBe(primary)

    // The whole cycle stays reachable and returns to the primary action.
    const order = [
      screen.getByRole('button', { name: '使用其他 Solid 账号' }),
      screen.getByRole('button', { name: '注册 Xpod' }),
      screen.getByRole('button', { name: '关闭登录' }),
      screen.getByText('什么是 WebID？'),
      screen.getByText('什么是 Pod？'),
      noticeSummary,
      primary,
    ]
    for (const expected of order) {
      tab()
      expect(document.activeElement).toBe(expected)
    }

    shiftTab()
    expect(document.activeElement).toBe(noticeSummary)
  })

  it('reaches the copy button only while the detail is expanded, then keeps cycling after it collapses', () => {
    renderDeveloperDialog()
    const primary = screen.getByRole('button', { name: '重试' })
    const noticeSummary = screen.getByText('暂时无法连接，请重试').closest('summary') as HTMLElement
    const copy = screen.getByRole('button', { name: '复制' })
    const details = noticeSummary.closest('details') as HTMLDetailsElement

    tab()
    expect(document.activeElement).toBe(primary)

    fireEvent.click(noticeSummary)
    expect(details.open).toBe(true)
    noticeSummary.focus()
    tab()
    expect(document.activeElement).toBe(copy)

    fireEvent.click(noticeSummary)
    expect(details.open).toBe(false)
    noticeSummary.focus()
    tab()
    expect(document.activeElement).toBe(primary)
  })
})

describe('StorageBadge and IdpChrome', () => {
  it('labels where the data lives for screen readers and hover', () => {
    render(<StorageBadge kind="cloud" label="数据存在 Xpod 云端" />)
    const badge = screen.getByRole('img', { name: '数据存在 Xpod 云端' })
    expect(badge.getAttribute('title')).toBe('数据存在 Xpod 云端')
    expect(badge.getAttribute('data-storage-kind')).toBe('cloud')
  })

  it('names the sign-in service and its host, defaulting to the Xpod mark', () => {
    const { container } = render(<IdpChrome serviceName="Xpod" serviceHost="pod.undefineds.co" />)
    expect(screen.getByText('Xpod · 账号服务')).toBeTruthy()
    expect(screen.getByText('pod.undefineds.co')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
    cleanup()
    render(<IdpChrome serviceName="Xpod" locale="en" icon={<i data-testid="custom" />} />)
    expect(screen.getByText('Xpod · Sign-in service')).toBeTruthy()
    expect(screen.getByTestId('custom')).toBeTruthy()
  })
})

describe('PodSignIn A0 restoring', () => {
  beforeEach(() => vi.useFakeTimers())

  it('shows only the source mark before 300ms, then the remembered name with a stage label', () => {
    renderSignIn({ state: { kind: 'restoring', identity } })
    expect(document.querySelector('[data-pod-sign-in="source"]')?.textContent).toBe('Northstar')
    expect(screen.queryByText('Ari Chen')).toBeNull()
    expect(screen.queryByText('正在恢复登录…')).toBeNull()
    // The single h1 exists even while nothing is revealed.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)

    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByRole('heading', { level: 1, name: 'Ari Chen' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('正在恢复登录…')
    expect(screen.getByRole('img', { name: '数据存在这台电脑上' })).toBeTruthy()
  })
})

describe('PodSignIn A1 remembered', () => {
  it('renders the name as the only heading and enters on the primary action', () => {
    const onUseAnother = vi.fn()
    const { onPrimary } = renderSignIn({ state: { kind: 'remembered', identity }, onUseAnother })
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Ari Chen' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '进入 Northstar' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '使用其他账号' }))
    expect(onUseAnother).toHaveBeenCalledTimes(1)
  })

  it('spins and disables the primary action while busy instead of showing another screen', () => {
    renderSignIn({ state: { kind: 'remembered', identity, busy: true } })
    const button = screen.getByRole('button', { name: '进入 Northstar' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.querySelector('svg.animate-spin')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Ari Chen' })).toBeTruthy()
  })

  it('has en copy and accepts partial copy overrides', () => {
    renderSignIn({ state: { kind: 'remembered', identity }, locale: 'en', onUseAnother: () => undefined })
    expect(screen.getByRole('button', { name: 'Open Northstar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use another account' })).toBeTruthy()
    cleanup()
    renderSignIn({ state: { kind: 'remembered', identity }, copy: { enterApp: '打开 {app} 工作台' } })
    expect(screen.getByRole('button', { name: '打开 Northstar 工作台' })).toBeTruthy()
  })
})

describe('PodSignIn A2 expired', () => {
  it('explains the expiry under the name and offers sign in again', () => {
    const { onPrimary } = renderSignIn({ state: { kind: 'expired', identity } })
    expect(screen.getByText('登录已过期，需要重新确认')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
  })

  it('is busy on the primary action without a verifying screen', () => {
    renderSignIn({ state: { kind: 'expired', identity, busy: true } })
    expect((screen.getByRole('button', { name: '重新登录' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PodSignIn A3 choose-service', () => {
  it('leads with the Xpod account, then other Solid accounts, then register', () => {
    const onRegister = vi.fn()
    const onToggleCustom = vi.fn()
    const { onPrimary } = renderSignIn({ state: { kind: 'choose-service' }, onRegister, onToggleCustom })

    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: '登录' })).toBeTruthy()
    expect(screen.getByText(/数据保存在你自己的 Pod 里/)).toBeTruthy()
    // Folded explanations live in <details>.
    expect(screen.getByText('什么是 WebID？').closest('details')).not.toBeNull()
    expect(screen.getByText('什么是 Pod？').closest('details')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /使用 Xpod 账号登录/ }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '注册 Xpod' }))
    expect(onRegister).toHaveBeenCalledTimes(1)

    expect(screen.queryByLabelText('账号服务地址或 WebID')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '使用其他 Solid 账号' }))
    expect(onToggleCustom).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('账号服务地址或 WebID')).toBeTruthy()
  })

  it('submits the custom service and shows its error next to the field', () => {
    const onCustomService = vi.fn()
    renderSignIn({
      state: { kind: 'choose-service', customOpen: true, customError: '地址不是有效的账号服务' },
      onCustomService,
    })
    const input = screen.getByLabelText('账号服务地址或 WebID') as HTMLInputElement
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('地址不是有效的账号服务')
    fireEvent.change(input, { target: { value: ' https://solid.example/ ' } })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onCustomService).toHaveBeenCalledWith('https://solid.example/')
  })

  it('honors capabilities and busy', () => {
    renderSignIn({
      state: { kind: 'choose-service', busy: true },
      capabilities: { customService: false, register: false },
      onRegister: () => undefined,
    })
    expect(screen.queryByRole('button', { name: '使用其他 Solid 账号' })).toBeNull()
    expect(screen.queryByRole('button', { name: '注册 Xpod' })).toBeNull()
    expect((screen.getByRole('button', { name: /使用 Xpod 账号登录/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PodSignIn C notices', () => {
  it('shows a warning as one assertive line and relabels the primary action', () => {
    const { onPrimary } = renderSignIn({
      state: { kind: 'remembered', identity },
      notice: { tone: 'warning', text: '暂时连不上 Xpod，请稍后再试', primaryLabel: '重试' },
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('暂时连不上 Xpod，请稍后再试')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '进入 Northstar' })).toBeNull()
  })

  it('shows a cancelled login as quiet grey status text without an error code', () => {
    renderSignIn({
      state: { kind: 'remembered', identity },
      notice: { tone: 'neutral', text: '登录已取消', developerDetail: 'phase=callback code=access_denied' },
    })
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('登录已取消')
    expect(screen.queryByText(/access_denied/)).toBeNull()
    expect(screen.getByRole('button', { name: '进入 Northstar' })).toBeTruthy()
  })

  it('reveals technical detail only in developer mode, and can copy it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const notice = {
      tone: 'warning' as const,
      text: '登录没有完成，请再试一次',
      primaryLabel: '重新登录',
      developerDetail: 'phase=callback code=state_mismatch host=pod.undefineds.co',
    }
    const { rerender } = render(
      <PodSignIn app={app} state={{ kind: 'remembered', identity }} notice={notice} onPrimary={() => undefined} />,
    )
    expect(screen.getByRole('alert').closest('details')).toBeNull()
    expect(screen.queryByText(/state_mismatch/)).toBeNull()

    rerender(
      <PodSignIn app={app} state={{ kind: 'remembered', identity }} notice={notice} developerMode onPrimary={() => undefined} />,
    )
    const details = screen.getByRole('alert').querySelector('details')!
    expect(details).not.toBeNull()
    expect(within(details).getByText(/state_mismatch/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(writeText).toHaveBeenCalledWith(notice.developerDetail)
  })

  it('applies to choose-service too', () => {
    renderSignIn({
      state: { kind: 'choose-service' },
      notice: { tone: 'warning', text: '这台电脑上的 Xpod 没有运行', primaryLabel: '启动 Xpod 并进入' },
    })
    expect(screen.getByRole('alert').textContent).toBe('这台电脑上的 Xpod 没有运行')
    expect(screen.getByRole('button', { name: '启动 Xpod 并进入' })).toBeTruthy()
  })
})

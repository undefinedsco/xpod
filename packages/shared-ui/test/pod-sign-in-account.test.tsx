// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AddDeviceDialog,
  ConsentResumeBanner,
  CreateWebIdForm,
  CredentialSection,
  DevicePickerDialog,
  DeviceSection,
  NetworkPanel,
  WebIdSection,
  type CreateWebIdFormProps,
  type DeviceSummary,
  type NetworkPanelProps,
  type TunnelOption,
} from '../src'

afterEach(() => cleanup())

const cloud: DeviceSummary = { id: 'cloud', name: 'Xpod 云端', kind: 'cloud', address: 'pod.undefineds.co', status: 'ok', podCount: 2 }
const laptop: DeviceSummary = { id: 'laptop', name: '这台电脑', kind: 'edge', address: 'node-7f3a.undefineds.co', status: 'ok', podCount: 1 }
const nas: DeviceSummary = { id: 'nas', name: 'NAS', kind: 'edge', status: 'stopped' }
const away: DeviceSummary = { id: 'away', name: '工作室电脑', kind: 'edge', status: 'offline' }
const devices = [cloud, laptop, nas, away]

// The four tunnels as the tunnel catalog describes them: fields come from data.
const tunnels: TunnelOption[] = [
  { id: 'cloudflare', label: 'Cloudflare', parameterFields: [], credentialField: { key: 'token', label: 'Tunnel token', secret: true } },
  { id: 'ngrok', label: 'ngrok', parameterFields: [], credentialField: { key: 'authtoken', label: 'Authtoken', secret: true } },
  { id: 'sakura_frp', label: 'SakuraFrp', parameterFields: [], credentialField: { key: 'accessKey', label: 'Access key', secret: true } },
  {
    id: 'frp',
    label: '自建 FRP',
    parameterFields: [
      { key: 'serverHost', label: 'Server host' },
      { key: 'serverPort', label: 'Server port' },
      { key: 'remotePort', label: 'Remote port' },
    ],
  },
]

function networkProps(overrides: Partial<NetworkPanelProps> = {}): NetworkPanelProps {
  return {
    checks: { local: 'ok', lan: 'ok', wan: 'failed' },
    tunnels,
    fieldValues: {},
    onSelectTunnel: vi.fn(),
    onFieldChange: vi.fn(),
    onEnable: vi.fn(),
    onRecheck: vi.fn(),
    ...overrides,
  }
}

describe('NetworkPanel', () => {
  it('shows the three checks and the standing footnote', () => {
    render(<NetworkPanel {...networkProps({ checks: { local: 'ok', lan: 'checking', wan: 'idle' } })} />)
    expect(screen.getByRole('heading', { name: '网络访问' })).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('data-probe'))).toEqual(['local', 'lan', 'wan'])
    expect(within(items[0]!).getByText('这台电脑')).toBeTruthy()
    expect(within(items[1]!).getByText('检测中')).toBeTruthy()
    expect(within(items[2]!).getByText('未检测')).toBeTruthy()
    expect(screen.getByText('只影响其他设备；这台电脑上照常可用')).toBeTruthy()
    // Nothing to fix yet: no tunnel choices.
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('offers the four tunnels when the public entry fails and renders fields from the description', () => {
    const props = networkProps({ selectedTunnelId: 'frp', fieldValues: { serverHost: 'frp.example' } })
    render(<NetworkPanel {...props} />)
    const group = screen.getByRole('radiogroup', { name: '选择隧道' })
    expect(within(group).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value))
      .toEqual(['cloudflare', 'ngrok', 'sakura_frp', 'frp'])
    expect((within(group).getByRole('radio', { name: '自建 FRP' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Server host') as HTMLInputElement).value).toBe('frp.example')
    expect(screen.getByLabelText('Server port')).toBeTruthy()
    expect(screen.getByLabelText('Remote port')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Server port'), { target: { value: '7000' } })
    expect(props.onFieldChange).toHaveBeenCalledWith('serverPort', '7000')
    fireEvent.click(within(group).getByRole('radio', { name: 'ngrok' }))
    expect(props.onSelectTunnel).toHaveBeenCalledWith('ngrok')
  })

  it('renders a secret credential field as a password input', () => {
    render(<NetworkPanel {...networkProps({ selectedTunnelId: 'cloudflare' })} />)
    expect((screen.getByLabelText('Tunnel token') as HTMLInputElement).type).toBe('password')
  })

  it('enables and rechecks, and needs a chosen tunnel to enable', () => {
    const props = networkProps()
    const { rerender } = render(<NetworkPanel {...props} />)
    expect((screen.getByRole('button', { name: '开启并重新检测' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(props.onRecheck).toHaveBeenCalledTimes(1)

    rerender(<NetworkPanel {...props} selectedTunnelId="ngrok" />)
    fireEvent.click(screen.getByRole('button', { name: '开启并重新检测' }))
    expect(props.onEnable).toHaveBeenCalledTimes(1)
  })

  it('states how the entry became reachable', () => {
    render(<NetworkPanel {...networkProps({ checks: { local: 'ok', lan: 'ok', wan: 'ok' }, activeTunnelLabel: 'Cloudflare' })} />)
    expect(screen.getByRole('status').textContent).toBe('通过 Cloudflare 可以访问')
  })

  it('switches its actions when used inside add-device', () => {
    const onSkip = vi.fn()
    render(<NetworkPanel {...networkProps({ selectedTunnelId: 'ngrok', onSkip })} />)
    fireEvent.click(screen.getByRole('button', { name: '跳过，稍后设置' }))
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '开启并检测' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新检测' })).toBeNull()
  })
})

describe('DevicePickerDialog', () => {
  it('lists every device, selects one with a click and closes, and blocks offline devices', () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    const onAddDevice = vi.fn()
    render(
      <DevicePickerDialog
        open
        onOpenChange={onOpenChange}
        devices={devices}
        selectedDeviceId="cloud"
        onSelect={onSelect}
        onAddDevice={onAddDevice}
      />,
    )
    expect(screen.getByRole('dialog', { name: '选择存放设备' })).toBeTruthy()
    const group = screen.getByRole('radiogroup', { name: '选择存放设备' })
    const radios = within(group).getAllByRole('radio') as HTMLButtonElement[]
    expect(radios).toHaveLength(4)
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    expect(radios[3]!.disabled).toBe(true)

    fireEvent.click(radios[3]!)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(radios[1]!)
    expect(onSelect).toHaveBeenCalledWith('laptop')
    expect(onOpenChange).toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加设备' }))
    expect(onAddDevice).toHaveBeenCalledTimes(1)
  })

  it('renders nothing while closed', () => {
    render(<DevicePickerDialog open={false} onOpenChange={() => undefined} devices={devices} onSelect={() => undefined} onAddDevice={() => undefined} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('AddDeviceDialog', () => {
  const baseNetwork = (() => {
    const { onSkip: _skip, locale: _l, copy: _c, ...rest } = networkProps()
    void _skip; void _l; void _c
    return rest
  })()

  function renderDialog(overrides: Partial<Parameters<typeof AddDeviceDialog>[0]> = {}) {
    const handlers = {
      onOpenChange: vi.fn(),
      onJoinThisComputer: vi.fn(),
      onNetworkDone: vi.fn(),
      onFinish: vi.fn(),
    }
    render(
      <AddDeviceDialog
        open
        step={1}
        network={baseNetwork}
        origin="device-section"
        {...handlers}
        {...overrides}
      />,
    )
    return handlers
  }

  it('step 1 waits for a new device and joins this computer only when the host can', () => {
    const { onJoinThisComputer } = renderDialog({ canJoinThisComputer: true })
    expect(screen.getByRole('dialog', { name: '添加设备' })).toBeTruthy()
    const steps = screen.getAllByRole('listitem')
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual(['step', null, null])
    expect(screen.getByText('正在等待新设备上线，登录后这里会自动继续')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '把这台电脑加入' }))
    expect(onJoinThisComputer).toHaveBeenCalledTimes(1)
  })

  it('step 1 shows no join action without host capability', () => {
    renderDialog({ canJoinThisComputer: false })
    expect(screen.queryByRole('button', { name: '把这台电脑加入' })).toBeNull()
    expect(screen.getByText('在那台设备上安装 Xpod 边缘并登录本账号')).toBeTruthy()
  })

  it('step 2 shows the new device, checks, and lets the user skip an unreachable network', () => {
    const { onNetworkDone } = renderDialog({ step: 2, device: laptop })
    expect(within(screen.getByRole('list', { name: '添加设备' })).getAllByRole('listitem').map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null])
    expect(screen.getByText('已上线')).toBeTruthy()
    expect(screen.getByText('node-7f3a.undefineds.co')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '选择隧道' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过，稍后设置' }))
    expect(onNetworkDone).toHaveBeenCalledTimes(1)
  })

  it('step 2 offers a plain continue once the network is reachable', () => {
    const { onNetworkDone } = renderDialog({
      step: 2,
      device: laptop,
      network: { ...baseNetwork, checks: { local: 'ok', lan: 'ok', wan: 'ok' } },
    })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onNetworkDone).toHaveBeenCalledTimes(1)
  })

  it('step 3 finishes as "Done" from the device section and "Use this device" from the picker', () => {
    const first = renderDialog({ step: 3, device: laptop })
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(first.onFinish).toHaveBeenCalledTimes(1)
    cleanup()
    const second = renderDialog({ step: 3, device: laptop, origin: 'picker' })
    fireEvent.click(screen.getByRole('button', { name: '用这台设备' }))
    expect(second.onFinish).toHaveBeenCalledTimes(1)
  })
})

describe('DeviceSection', () => {
  function renderSection(overrides: Partial<Parameters<typeof DeviceSection>[0]> = {}) {
    const handlers = {
      onAddDevice: vi.fn(),
      onToggleNetwork: vi.fn(),
      onStartDevice: vi.fn(),
    }
    render(<DeviceSection devices={devices} {...handlers} {...overrides} />)
    return handlers
  }

  it('lists the cloud and edge devices with their statuses in words', () => {
    renderSection()
    expect(screen.getByRole('heading', { name: '设备' })).toBeTruthy()
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(within(rows[0]!).getByText('Xpod 云端', { selector: 'span.rounded' })).toBeTruthy()
    expect(within(rows[0]!).getByText('正常')).toBeTruthy()
    expect(within(rows[1]!).getByText('node-7f3a.undefineds.co')).toBeTruthy()
    expect(within(rows[2]!).getByText('Xpod 已停止')).toBeTruthy()
    expect(within(rows[3]!).getByText('离线')).toBeTruthy()
  })

  it('offers network only on edge devices, start only on online stopped ones, and add device', () => {
    const handlers = renderSection()
    expect(screen.getAllByRole('button', { name: /^(网络|处理|收起)/ })).toHaveLength(3)
    const [cloudRow, , nasRow, awayRow] = screen.getAllByRole('listitem')
    expect(within(cloudRow!).queryByRole('button')).toBeNull()
    expect(within(awayRow!).queryByRole('button', { name: '启动' })).toBeNull()
    fireEvent.click(within(nasRow!).getByRole('button', { name: '启动' }))
    expect(handlers.onStartDevice).toHaveBeenCalledWith('nas')
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加设备' }))
    expect(handlers.onAddDevice).toHaveBeenCalledTimes(1)
    fireEvent.click(within(screen.getAllByRole('listitem')[1]!).getByRole('button', { name: /^(网络|处理|收起)/ }))
    expect(handlers.onToggleNetwork).toHaveBeenCalledWith('laptop')
  })

  it('hides Start when the host cannot start Xpod', () => {
    renderSection({ onStartDevice: undefined })
    expect(screen.queryByRole('button', { name: '启动' })).toBeNull()
  })

  it('expands the network panel under the chosen device', () => {
    renderSection({ networkDeviceId: 'laptop', network: networkProps() })
    const laptopRow = screen.getAllByRole('listitem')[1]!
    expect(within(laptopRow).getByRole('button', { name: /^(网络|处理|收起)/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(laptopRow).getByRole('heading', { name: '网络访问' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { name: '网络访问' })).toHaveLength(1)
  })

  it('shows a spinner on the device being started', () => {
    renderSection({ startingDeviceId: 'nas' })
    const start = within(screen.getAllByRole('listitem')[2]!).getByRole('button', { name: '启动' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(start.getAttribute('aria-busy')).toBe('true')
  })
})

describe('CreateWebIdForm', () => {
  function Harness(overrides: Partial<CreateWebIdFormProps> & { start?: string } = {}) {
    const [selected, setSelected] = useState(overrides.start ?? 'laptop')
    const { start: _start, ...rest } = overrides
    void _start
    return (
      <CreateWebIdForm
        name="ari"
        onNameChange={() => undefined}
        addressPreview="node-7f3a.undefineds.co/ari/"
        devices={devices}
        selectedDeviceId={selected}
        onSelectDevice={setSelected}
        onAddDevice={() => undefined}
        onSubmit={() => undefined}
        {...rest}
      />
    )
  }

  it('shows the name step and a summary card of the selected device with a change link', () => {
    render(<Harness />)
    expect(screen.getByRole('form', { name: '新建 WebID' })).toBeTruthy()
    expect(screen.getByText('node-7f3a.undefineds.co/ari/')).toBeTruthy()
    const card = document.querySelector('[data-pod-sign-in="selected-device"]') as HTMLElement
    expect(within(card).getByText('这台电脑')).toBeTruthy()
    expect(within(card).getByRole('button', { name: '更换 ›' })).toBeTruthy()
    expect(screen.getByText('创建后不能直接更换，以后要换请使用迁移')).toBeTruthy()
  })

  it('changes the device through the picker: one click selects and closes', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '更换 ›' }))
    const dialog = screen.getByRole('dialog', { name: '选择存放设备' })
    fireEvent.click(within(dialog).getByRole('radio', { name: /Xpod 云端/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const card = document.querySelector('[data-pod-sign-in="selected-device"]') as HTMLElement
    expect(within(card).getByText('Xpod 云端', { selector: 'span.truncate' })).toBeTruthy()
  })

  it('hands "add device" to the host and closes the picker', () => {
    const onAddDevice = vi.fn()
    render(<Harness onAddDevice={onAddDevice} />)
    fireEvent.click(screen.getByRole('button', { name: '更换 ›' }))
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加设备' }))
    expect(onAddDevice).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('creates in one step on a running device', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: '创建 WebID 和 Pod' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('starts Xpod first on a stopped device, before any creation', () => {
    const onSubmit = vi.fn()
    const onStartDevice = vi.fn()
    render(<Harness start="nas" onSubmit={onSubmit} onStartDevice={onStartDevice} />)
    expect(screen.queryByRole('button', { name: '创建 WebID 和 Pod' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '启动这台设备上的 Xpod' }))
    expect(onStartDevice).toHaveBeenCalledWith('nas')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('notes that closing the page does not interrupt creation, and locks while creating', () => {
    render(<Harness creating />)
    expect(screen.getByRole('status').textContent).toContain('关闭页面不会中断创建')
    expect((screen.getByRole('button', { name: '创建 WebID 和 Pod' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '更换 ›' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('announces a taken name and blocks creation', () => {
    const onSubmit = vi.fn()
    render(<Harness nameHint={{ tone: 'error', text: '名称已被占用' }} onSubmit={onSubmit} />)
    expect(screen.getByRole('alert').textContent).toBe('名称已被占用')
    const button = screen.getByRole('button', { name: '创建 WebID 和 Pod' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})

describe('WebIdSection', () => {
  const entry = {
    id: 'ari',
    displayName: 'Ari',
    webId: 'https://node-7f3a.undefineds.co/ari/profile/card#me',
    storage: { kind: 'edge' as const, label: '数据存在这台电脑上' },
    deviceId: 'laptop',
    deviceName: '这台电脑',
    authorizedAppCount: 3,
  }
  const createForm: CreateWebIdFormProps = {
    name: 'ari-2',
    onNameChange: () => undefined,
    devices,
    selectedDeviceId: 'laptop',
    onSelectDevice: () => undefined,
    onAddDevice: () => undefined,
    onSubmit: () => undefined,
  }

  it('lists WebIDs with their Pod device and authorized apps, form collapsed', () => {
    const onGoToDevice = vi.fn()
    const onCreateOpenChange = vi.fn()
    render(
      <WebIdSection
        webIds={[entry]}
        createOpen={false}
        onCreateOpenChange={onCreateOpenChange}
        createForm={createForm}
        onLinkExisting={() => undefined}
        onGoToDevice={onGoToDevice}
      />,
    )
    expect(screen.getByRole('heading', { name: 'WebID' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '数据存在这台电脑上' })).toBeTruthy()
    expect(screen.getByText('已授权 3 个应用')).toBeTruthy()
    expect(screen.queryByRole('form')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pod 在 这台电脑' }))
    expect(onGoToDevice).toHaveBeenCalledWith('laptop')
    expect(screen.getByRole('button', { name: '关联已有 WebID' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建 WebID' }))
    expect(onCreateOpenChange).toHaveBeenCalledWith(true)
  })

  it('opens the form below existing rows, hides the new button, and can be dismissed', () => {
    const onCreateOpenChange = vi.fn()
    render(
      <WebIdSection webIds={[entry]} createOpen onCreateOpenChange={onCreateOpenChange} createForm={createForm} />,
    )
    expect(screen.getByRole('form', { name: '新建 WebID' })).toBeTruthy()
    // Only the form's own heading-less controls remain; the header button is hidden.
    expect(screen.queryByRole('button', { name: '新建 WebID' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCreateOpenChange).toHaveBeenCalledWith(false)
  })

  it('with no WebID shows one explanatory row and the expanded form without cancel', () => {
    render(<WebIdSection webIds={[]} createOpen onCreateOpenChange={() => undefined} createForm={createForm} />)
    expect(screen.getByText('还没有 WebID。新建一个，用它登录应用。')).toBeTruthy()
    expect(screen.getByRole('form', { name: '新建 WebID' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
  })
})

describe('CredentialSection', () => {
  it('disables creating without a WebID and shows the empty line', () => {
    render(<CredentialSection credentials={[]} canCreate={false} onCreate={() => undefined} />)
    expect(screen.getByRole('heading', { name: '密钥' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '新建密钥' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('还没有密钥。')).toBeTruthy()
  })

  it('creates and revokes credentials', () => {
    const onCreate = vi.fn()
    const onRevoke = vi.fn()
    render(
      <CredentialSection
        credentials={[{ id: 'c1', label: 'CI', webIdName: 'Ari', createdLabel: '9月29日' }]}
        canCreate
        onCreate={onCreate}
        onRevoke={onRevoke}
      />,
    )
    expect(screen.getByText('Ari · 9月29日')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建密钥' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 CI' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onRevoke).toHaveBeenCalledWith('c1')
  })
})

describe('ConsentResumeBanner', () => {
  const app = { name: 'Northstar', icon: <svg data-testid="app-icon" /> }

  it('waits for a Pod: continue is disabled and the status says to create one', () => {
    const onCancel = vi.fn()
    render(<ConsentResumeBanner app={app} podReady={false} onContinue={() => undefined} onCancel={onCancel} />)
    expect(screen.getByRole('region', { name: 'Northstar 正在等你完成授权' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('在下面新建一个 WebID，完成后就能回去授权')
    expect((screen.getByRole('button', { name: '继续授权 Northstar' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消授权' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('lets the user go back once the Pod is ready', () => {
    const onContinue = vi.fn()
    render(<ConsentResumeBanner app={app} podReady onContinue={onContinue} onCancel={() => undefined} />)
    expect(screen.getByRole('status').textContent).toBe('WebID 已就绪，可以回去授权了')
    fireEvent.click(screen.getByRole('button', { name: '继续授权 Northstar' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('speaks English and honors a custom status text', () => {
    render(
      <ConsentResumeBanner app={app} podReady locale="en" statusText="Almost there" onContinue={() => undefined} onCancel={() => undefined} />,
    )
    expect(screen.getByRole('button', { name: 'Continue authorizing Northstar' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Almost there')
  })
})

describe('account page section headers and device actions', () => {
  it('labels the device action by status: Fix when unreachable, Network otherwise, Collapse when open', () => {
    const broken: DeviceSummary = { id: 'b', name: 'Studio', kind: 'edge', status: 'unreachable' }
    const { rerender } = render(<DeviceSection devices={[laptop, broken]} onAddDevice={() => undefined} onToggleNetwork={() => undefined} />)
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).getByRole('button', { name: '网络' })).toBeTruthy()
    expect(within(rows[1]!).getByRole('button', { name: '处理' })).toBeTruthy()
    rerender(<DeviceSection devices={[laptop, broken]} networkDeviceId="b" network={networkProps()} onAddDevice={() => undefined} onToggleNetwork={() => undefined} />)
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('gives each section an icon and one sentence of purpose', () => {
    const { container } = render(
      <>
        <DeviceSection devices={[cloud]} onAddDevice={() => undefined} onToggleNetwork={() => undefined} />
        <CredentialSection credentials={[]} canCreate onCreate={() => undefined} />
      </>,
    )
    expect(screen.getByText('Pod 可以存放的地方，网络设置跟着设备走')).toBeTruthy()
    expect(screen.getByText('让脚本或服务以某个 WebID 直接访问 Pod')).toBeTruthy()
    expect(container.querySelectorAll('h2 svg, svg.h-\\[18px\\]').length).toBeGreaterThanOrEqual(0)
    expect(container.querySelectorAll('section > div > div > svg')).toHaveLength(2)
  })
})

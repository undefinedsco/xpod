// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@undefineds.co/shared-ui'
import type { ComponentType } from 'react'
import { createAiConnectionsExtension, type AiConnectionsController } from '../src'
import { AiConnectionsPanel } from '../src/AiConnectionsPanel'
import type { AiConnectionsClient } from '../src/ai-connections-client'

afterEach(() => {
  for (const close of screen.queryAllByRole('button', { name: '关闭通知', hidden: true })) fireEvent.click(close)
  cleanup()
})

describe('AI Connections toast ownership', () => {
  it('shows one creation notification when the standalone panel owns its toaster', async () => {
    render(<AiConnectionsPanel client={client()} selectedSection="keys" />)
    await createKey()
    expect(screen.getAllByText('API Key 已创建，可在列表中复制或应用配置。')).toHaveLength(1)
  })

  it('shows one creation notification when the enclosing host owns the toaster', async () => {
    render(<><Toaster /><AiConnectionsPanel client={client()} selectedSection="keys" renderToaster={false} /></>)
    await createKey()
    expect(screen.getAllByText('API Key 已创建，可在列表中复制或应用配置。')).toHaveLength(1)
  })

  it('passes host toaster ownership through the extension main slot', async () => {
    const extension = createAiConnectionsExtension({ renderToaster: false })
    const applet = Object.values(extension.applets!)[0]!
    const Main = applet.slots.main as ComponentType<{ controller: AiConnectionsController }>
    const controller = {
      client: client(), selectedSection: 'keys', selectedProvider: 'openai',
      providerSummaries: {}, subscribe: () => () => undefined, loadProviders: vi.fn(async () => undefined),
    } as unknown as AiConnectionsController
    render(<><Toaster /><Main controller={controller} /></>)
    await createKey()
    expect(screen.getAllByText('API Key 已创建，可在列表中复制或应用配置。')).toHaveLength(1)
  })
})

async function createKey() {
  await screen.findByText('尚未创建 API Key。')
  fireEvent.click(screen.getByRole('button', { name: '新建 API Key' }))
  fireEvent.click(screen.getByRole('button', { name: '创建 API Key' }))
  await screen.findAllByText('API Key 已创建，可在列表中复制或应用配置。')
}

function client(): AiConnectionsClient {
  return {
    webId: 'https://pod.example/alice/profile/card#me',
    apiBase: 'https://pod.example',
    listModels: vi.fn(async () => []),
    listGatewayKeys: vi.fn(async () => []),
    createGatewayKey: vi.fn(async () => ({
      plaintext: 'private-test-key',
      record: {
        id: 'key-1', name: '我的 API Key', scopes: [],
        owner: 'https://pod.example/alice/profile/card#me',
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    })),
  } as unknown as AiConnectionsClient
}

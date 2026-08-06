import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  cn,
} from '@undefineds.co/shared-ui'
import { Box, Brain, Globe, Image as ImageIcon } from 'lucide-react'

export interface AiModelEditorValue {
  id: string
  name: string
  capabilities: string[]
}

export interface AiModelEditorDialogProps {
  open: boolean
  providerName: string
  initialValue?: AiModelEditorValue
  error?: string
  saving?: boolean
  onOpenChange: (open: boolean) => void
  onSave: (model: AiModelEditorValue) => void
}

const capabilityOptions = [
  { id: 'image', label: '视觉识别', icon: ImageIcon },
  { id: 'tool_call', label: '函数调用', icon: Box },
  { id: 'reasoning', label: '推理', icon: Brain },
  { id: 'web', label: '联网搜索', icon: Globe },
] as const

export function AiModelEditorDialog({
  open,
  providerName,
  initialValue,
  error,
  saving = false,
  onOpenChange,
  onSave,
}: AiModelEditorDialogProps) {
  const editing = Boolean(initialValue)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setId(initialValue?.id ?? '')
    setName(initialValue?.name ?? '')
    setCapabilities(initialValue?.capabilities ?? [])
  }, [initialValue, open])

  const normalizedId = id.trim()
  const canSave = Boolean(normalizedId) && !saving

  const toggleCapability = (capability: string) => {
    setCapabilities((current) => current.includes(capability)
      ? current.filter((item) => item !== capability)
      : [...current, capability])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑模型' : '添加模型'} · {providerName}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-model-id">模型 ID</Label>
            <Input
              id="ai-model-id"
              value={id}
              disabled={editing || saving}
              placeholder="例如 gpt-4o-mini"
              onChange={(event) => setId(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-model-name">显示名称</Label>
            <Input
              id="ai-model-name"
              value={name}
              disabled={saving}
              placeholder="留空则使用模型 ID"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>能力标记</Label>
            <div className="flex flex-wrap gap-2">
              {capabilityOptions.map((option) => {
                const active = capabilities.includes(option.id)
                const Icon = option.icon
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    disabled={saving}
                    onClick={() => toggleCapability(option.id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                      active
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>

          {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => onSave({
              id: normalizedId,
              name: name.trim(),
              capabilities,
            })}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

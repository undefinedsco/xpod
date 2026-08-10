import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from './button'
import { Card } from './card'
import { Input } from './input'
import { Label } from './label'

export function ConnectSurface({
  children,
  labelledBy,
}: {
  children: ReactNode
  labelledBy?: string
}) {
  return (
    <section
      className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground"
      aria-labelledby={labelledBy}
      data-auth-boundary="surface"
    >
      <Card className="w-full max-w-md rounded-lg border border-border bg-layout-content px-8 py-7 shadow-sm">
        {children}
      </Card>
    </section>
  )
}

export interface SolidConnectFormProps {
  defaultIssuer?: string
  pending?: boolean
  error?: string
  submitErrorMessage?: string
  copy?: SolidConnectCopy
  onConnect: (issuer: string) => void | Promise<void>
}

export interface SolidConnectCopy {
  issuerLabel: string
  issuerPlaceholder: string
  submitLabel: string
  pendingLabel: string
  errorMessage: string
}

export function SolidConnectForm({
  defaultIssuer = '',
  pending: pendingExternal = false,
  error,
  submitErrorMessage,
  copy,
  onConnect,
}: SolidConnectFormProps) {
  const issuerId = useId()
  const errorId = useId()
  const [issuer, setIssuer] = useState(defaultIssuer)
  const [pendingInternal, setPendingInternal] = useState(false)
  const [submitError, setSubmitError] = useState<string | undefined>()
  const normalizedIssuer = issuer.trim()
  const pending = pendingExternal || pendingInternal
  const visibleError = submitError || error
  const submitLabel = pending ? copy?.pendingLabel : copy?.submitLabel

  const describedBy = useMemo(() => (
    visibleError ? errorId : undefined
  ), [errorId, visibleError])

  if (!copy) return null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!normalizedIssuer || pending) {
      return
    }

    setPendingInternal(true)
    setSubmitError(undefined)

    try {
      await onConnect(normalizedIssuer)
    } catch {
      setSubmitError(copy?.errorMessage ?? submitErrorMessage)
    } finally {
      setPendingInternal(false)
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex flex-col gap-2 text-left">
        <Label htmlFor={issuerId}>{copy.issuerLabel}</Label>
        <Input
          id={issuerId}
          type="url"
          value={issuer}
          disabled={pending}
          aria-invalid={visibleError ? true : undefined}
          aria-describedby={describedBy}
          placeholder={copy.issuerPlaceholder}
          className="border-border/60 bg-background focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          onChange={(event) => setIssuer(event.currentTarget.value)}
        />
      </div>

      {visibleError ? (
        <p
          id={errorId}
          className="flex items-center gap-1.5 text-left text-xs text-destructive"
          role="alert"
        >
          <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {visibleError}
        </p>
      ) : null}

      {submitLabel ? <Button
        type="submit"
        className="w-full"
        disabled={!normalizedIssuer || pending}
      >
        {submitLabel}
      </Button> : null}
    </form>
  )
}

export interface ConnectHeaderProps {
  title: ReactNode
  titleId?: string
  description?: ReactNode
  logo?: ReactNode
}

export function ConnectHeader({ title, titleId, description, logo }: ConnectHeaderProps) {
  return (
    <div className="flex flex-col gap-3 text-center">
      {logo ? (
        <div className="flex justify-center" aria-hidden="true">
          {logo}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <h1 id={titleId} className="text-2xl font-semibold leading-8 tracking-normal">
          {title}
        </h1>
        {description ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  )
}

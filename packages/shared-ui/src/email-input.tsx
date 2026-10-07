import * as React from 'react'
import { Input, type InputProps } from './input'

export type EmailInputProps = Omit<InputProps, 'type' | 'inputMode'>

/**
 * Native text selection for email fields, including Chrome integrations that
 * cannot preserve a type=email range. Validation still comes from the browser's
 * email implementation; the validator never enters the document or takes focus.
 */
export const EmailInput = React.forwardRef<HTMLInputElement, EmailInputProps>(
  ({ onInput, onChange, autoCapitalize = 'none', spellCheck = false, ...props }, forwardedRef) => {
    const inputRef = React.useRef<HTMLInputElement>(null)
    const validatorRef = React.useRef<HTMLInputElement | null>(null)
    React.useImperativeHandle(forwardedRef, () => inputRef.current!, [])

    const synchronizeValidity = React.useCallback((input: HTMLInputElement) => {
      const validator = validatorRef.current ??= input.ownerDocument.createElement('input')
      validator.type = 'email'
      validator.multiple = input.multiple
      validator.required = input.required
      validator.value = input.value
      input.setCustomValidity(validator.validity.valid ? '' : validator.validationMessage)
    }, [])

    React.useLayoutEffect(() => {
      if (inputRef.current) synchronizeValidity(inputRef.current)
    })

    React.useEffect(() => {
      const input = inputRef.current
      const form = input?.form
      if (!input || !form) return
      // Reset restores values after its event; validate the restored value.
      const onReset = () => queueMicrotask(() => synchronizeValidity(input))
      form.addEventListener('reset', onReset)
      return () => form.removeEventListener('reset', onReset)
    }, [props.form, synchronizeValidity])

    const validateEdit = (input: HTMLInputElement) => {
      synchronizeValidity(input)
      // React may restore a controlled value after the event handlers finish.
      queueMicrotask(() => synchronizeValidity(input))
    }

    return (
      <Input
        {...props}
        ref={inputRef}
        type="text"
        inputMode="email"
        autoCapitalize={autoCapitalize}
        spellCheck={spellCheck}
        onInput={(event) => { validateEdit(event.currentTarget); onInput?.(event) }}
        onChange={(event) => { validateEdit(event.currentTarget); onChange?.(event) }}
      />
    )
  },
)
EmailInput.displayName = 'EmailInput'

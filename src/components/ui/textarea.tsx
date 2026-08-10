'use client'

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CONTROL_BASE, CONTROL_READONLY, describedBy, FieldShell } from './field'

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  optional?: boolean
  /** Crece con el contenido en vez de scrollear. */
  autoResize?: boolean
  wrapperClassName?: string
}

export function Textarea({
  label,
  hint,
  error,
  optional,
  autoResize = false,
  className,
  wrapperClassName,
  id: idProp,
  required,
  rows = 4,
  onInput,
  ...props
}: TextareaProps) {
  const auto = useId()
  const id = idProp ?? auto

  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      className={wrapperClassName}
    >
      <textarea
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onInput={
          autoResize
            ? (event) => {
                const el = event.currentTarget
                el.style.height = 'auto'
                el.style.height = `${el.scrollHeight}px`
                onInput?.(event)
              }
            : onInput
        }
        className={cn(
          CONTROL_BASE,
          CONTROL_READONLY,
          'min-h-24 resize-y py-2.5 leading-relaxed',
          autoResize && 'resize-none overflow-hidden',
          className,
        )}
        {...props}
      />
    </FieldShell>
  )
}

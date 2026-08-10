'use client'

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CONTROL_BASE, CONTROL_READONLY, describedBy, FieldShell } from './field'

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size' | 'prefix'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  optional?: boolean
  /** Ícono o texto fijo a la izquierda (ej. una lupa, o "https://"). */
  prefix?: ReactNode
  /** Al final: unidad, botón de limpiar, contador. */
  suffix?: ReactNode
  wrapperClassName?: string
}

export function Input({
  label,
  hint,
  error,
  optional,
  prefix,
  suffix,
  className,
  wrapperClassName,
  id: idProp,
  required,
  ...props
}: InputProps) {
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
      <div className="relative flex items-center">
        {prefix && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 flex items-center text-ink-subtle [&_svg]:size-4"
          >
            {prefix}
          </span>
        )}

        <input
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className={cn(
            CONTROL_BASE,
            CONTROL_READONLY,
            'h-11',
            prefix && 'pl-9',
            suffix && 'pr-10',
            className,
          )}
          {...props}
        />

        {suffix && (
          <span className="absolute right-2 flex items-center text-ink-subtle [&_svg]:size-4">
            {suffix}
          </span>
        )}
      </div>
    </FieldShell>
  )
}

'use client'

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CONTROL_BASE, describedBy, FieldShell } from './field'

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  optional?: boolean
  /** Opción inicial vacía. Ej. "Elegí un proyecto". */
  placeholder?: string
  wrapperClassName?: string
}

/**
 * Usa el <select> nativo a propósito: en el celular abre la rueda del
 * sistema, que es más rápida y más accesible que cualquier lista custom.
 * Para menús de acciones (no de datos) usá DropdownMenu.
 */
export function Select({
  label,
  hint,
  error,
  optional,
  placeholder,
  className,
  wrapperClassName,
  id: idProp,
  required,
  children,
  ...props
}: SelectProps) {
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
        <select
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          defaultValue={placeholder && props.defaultValue === undefined && props.value === undefined ? '' : undefined}
          className={cn(CONTROL_BASE, 'h-11 cursor-pointer appearance-none pr-9', className)}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.9}
          className="pointer-events-none absolute right-3 size-4 text-ink-subtle"
        />
      </div>
    </FieldShell>
  )
}

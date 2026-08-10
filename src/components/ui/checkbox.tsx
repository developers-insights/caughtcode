'use client'

import { useEffect, useId, useRef, type ComponentPropsWithRef, type ReactNode } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fieldIds } from './field'

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** Estado "algunos sí, otros no" para casillas que agrupan. */
  indeterminate?: boolean
  wrapperClassName?: string
}

export function Checkbox({
  label,
  hint,
  error,
  indeterminate = false,
  className,
  wrapperClassName,
  id: idProp,
  disabled,
  ref,
  ...props
}: CheckboxProps) {
  const auto = useId()
  const id = idProp ?? auto
  const { hintId, errorId } = fieldIds(id)
  const inner = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {/* El área táctil abarca la etiqueta entera, no solo el cuadradito. */}
      <div className="flex items-start gap-3">
        <span className="relative flex size-11 shrink-0 items-center justify-center -m-2.5">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
            ref={(node) => {
              inner.current = node
              if (typeof ref === 'function') ref(node)
              else if (ref) ref.current = node
            }}
            className="peer absolute size-11 cursor-pointer opacity-0 disabled:cursor-not-allowed"
            {...props}
          />
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none flex size-5 items-center justify-center rounded-xs border border-field bg-surface',
              'text-transparent transition-[background-color,border-color,color] duration-150 ease-firm',
              'peer-checked:border-ink peer-checked:bg-ink peer-checked:text-ink-inverse',
              'peer-indeterminate:border-ink peer-indeterminate:bg-ink peer-indeterminate:text-ink-inverse',
              'peer-focus-visible:focus-ring',
              'peer-disabled:opacity-45',
              error && 'border-expuesto',
              className,
            )}
          >
            {indeterminate ? (
              <Minus className="size-3.5" strokeWidth={3} />
            ) : (
              <Check className="size-3.5" strokeWidth={3} />
            )}
          </span>
        </span>

        {label && (
          <label
            htmlFor={id}
            className={cn(
              'cursor-pointer pt-0.5 text-base leading-snug text-ink select-none',
              disabled && 'cursor-not-allowed opacity-45',
            )}
          >
            {label}
          </label>
        )}
      </div>

      {hint && !error && (
        <p id={hintId} className="pl-8 text-sm text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="pl-8 text-sm text-expuesto-text">
          {error}
        </p>
      )}
    </div>
  )
}

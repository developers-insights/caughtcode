'use client'

import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: ReactNode
  /** Ayuda debajo. Ej. "Te avisamos por mail cuando termine el análisis." */
  hint?: ReactNode
  disabled?: boolean
  /** Etiqueta accesible si no hay `label` visible. */
  'aria-label'?: string
  className?: string
}

/**
 * Interruptor de preferencia: se aplica al instante, sin botón de guardar.
 * Si la acción necesita confirmarse o cuesta plata, no va un switch — va un
 * botón con ConfirmDialog.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  className,
  ...props
}: SwitchProps) {
  const id = useId()
  const hintId = `${id}-hint`

  const control = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-describedby={hint ? hintId : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full',
        'transition-colors duration-200 ease-firm focus-visible:focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'bg-ink' : 'bg-line-strong',
        !label && className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute left-0.5 size-5 rounded-full bg-surface shadow-support',
          'transition-transform duration-200 ease-out-soft',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  )

  if (!label) return control

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-base font-medium text-ink">
          {label}
        </label>
        {hint && (
          <p id={hintId} className="mt-0.5 text-sm text-ink-muted">
            {hint}
          </p>
        )}
      </div>
      {control}
    </div>
  )
}

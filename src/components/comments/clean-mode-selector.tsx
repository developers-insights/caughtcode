'use client'

import { useId } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MODOS, type CleanMode } from './model-clean'

export interface CleanModeSelectorProps {
  value: CleanMode
  onChange: (mode: CleanMode) => void
  disabled?: boolean
  className?: string
}

/**
 * Cuánto sacar.
 *
 * Van dos opciones y no un interruptor porque no es una preferencia que se
 * aplica sola: es una decisión sobre el código de otra persona, y las dos
 * consecuencias tienen que poder leerse antes de elegir.
 */
export function CleanModeSelector({
  value,
  onChange,
  disabled = false,
  className,
}: CleanModeSelectorProps) {
  const name = useId()

  return (
    <fieldset className={cn('min-w-0', className)} disabled={disabled}>
      <legend className="mb-3 text-base font-medium text-ink">Cuánto querés sacar</legend>

      <div className="grid gap-3 sm:grid-cols-2">
        {MODOS.map((modo) => {
          const id = `${name}-${modo.id}`
          const elegido = value === modo.id

          return (
            <div key={modo.id} className="relative min-w-0">
              <input
                type="radio"
                id={id}
                name={name}
                value={modo.id}
                checked={elegido}
                onChange={() => onChange(modo.id)}
                className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              />
              <label
                htmlFor={id}
                className={cn(
                  'pointer-events-none flex h-full cursor-pointer flex-col gap-1.5 rounded-md border p-4',
                  'transition-[border-color,background-color,box-shadow] duration-150 ease-firm',
                  'peer-focus-visible:focus-ring peer-disabled:opacity-45',
                  elegido
                    ? 'border-ink bg-surface shadow-support'
                    : 'border-field bg-canvas-sunken/60 peer-hover:border-ink-subtle',
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border',
                      elegido
                        ? 'border-ink bg-ink text-ink-inverse'
                        : 'border-field bg-surface text-transparent',
                    )}
                  >
                    <Check className="size-3.5" strokeWidth={3} />
                  </span>
                  <span className="text-base font-semibold text-ink">{modo.titulo}</span>
                </span>
                <span className="text-sm leading-relaxed text-ink-muted">{modo.texto}</span>
              </label>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

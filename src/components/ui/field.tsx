import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Andamiaje común de los campos de formulario.
 *
 * Reglas que aplica sola, para no depender de que cada frente se acuerde:
 *  · La etiqueta siempre es visible. El placeholder NO es una etiqueta.
 *  · La ayuda vive debajo del campo y se queda ahí, no desaparece al tipear.
 *  · El error aparece pegado al campo que falló, con role="alert".
 *  · Los campos obligatorios se marcan con texto, no solo con un asterisco.
 */

export interface FieldShellProps {
  id: string
  label?: ReactNode
  /** Ayuda persistente. Ej. "Podés pegar el link del repo o subir un zip." */
  hint?: ReactNode
  /** Mensaje de error. Tiene que decir qué pasó Y cómo arreglarlo. */
  error?: ReactNode
  required?: boolean
  /** Marca el campo como opcional en vez de marcar los obligatorios. */
  optional?: boolean
  className?: string
  children: ReactNode
}

export function fieldIds(id: string) {
  return { hintId: `${id}-hint`, errorId: `${id}-error` }
}

export function describedBy(id: string, hint?: unknown, error?: unknown) {
  const { hintId, errorId } = fieldIds(id)
  const parts = [hint ? hintId : null, error ? errorId : null].filter(Boolean)
  return parts.length ? parts.join(' ') : undefined
}

export function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  optional,
  className,
  children,
}: FieldShellProps) {
  const { hintId, errorId } = fieldIds(id)

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium text-ink">
          <span>{label}</span>
          {required && (
            <span className="text-xs font-normal text-ink-subtle">(obligatorio)</span>
          )}
          {optional && !required && (
            <span className="text-xs font-normal text-ink-subtle">(opcional)</span>
          )}
        </label>
      )}

      {children}

      {hint && !error && (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}

      {error && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm text-expuesto-text">
          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-expuesto" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

/** Estilos base de un control de texto. 44px de alto = mínimo táctil. */
export const CONTROL_BASE =
  'w-full rounded-sm border bg-surface px-3 text-base text-ink placeholder:text-ink-subtle ' +
  'shadow-[var(--cc-shadow-inset)] transition-[border-color,box-shadow] duration-150 ease-firm ' +
  'focus:focus-ring hover:border-ink-subtle ' +
  'disabled:cursor-not-allowed disabled:bg-canvas-sunken disabled:text-ink-subtle disabled:shadow-none ' +
  'aria-invalid:border-expuesto aria-invalid:hover:border-expuesto'

/**
 * Solo lectura ≠ deshabilitado: el usuario puede seleccionar y copiar, pero
 * no editar. Va aparte porque `:read-only` en CSS también matchea a <select>.
 */
export const CONTROL_READONLY = 'read-only:bg-canvas-sunken read-only:text-ink-muted read-only:shadow-none'

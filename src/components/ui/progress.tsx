import { cn } from '@/lib/utils'
import { TONE_SOLID_BG, type Tone } from './severity'

export interface ProgressProps {
  /** 0 a 100. Omitilo para el modo indeterminado. */
  value?: number
  /** Qué está pasando ahora, en lenguaje llano. Ej. "Leyendo tu código". */
  label?: string
  /** Detalle al costado. Ej. "3 de 7 etapas" o "faltan ~2 min". */
  hint?: string
  tone?: Tone
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Barra de progreso.
 *
 * Regla del producto: si no sabemos cuánto falta, no mentimos con una barra
 * que avanza sola. Sin `value` la barra se muestra indeterminada — y el
 * texto de `label` tiene que decir qué está haciendo de verdad.
 */
export function Progress({
  value,
  label,
  hint,
  tone = 'neutral',
  size = 'md',
  className,
}: ProgressProps) {
  const indeterminate = value === undefined
  const clamped = indeterminate ? 0 : Math.min(100, Math.max(0, value))

  return (
    <div className={cn('w-full', className)}>
      {(label || hint) && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          {label && <span className="text-sm font-medium text-ink">{label}</span>}
          {hint && <span className="shrink-0 text-sm tabular text-ink-muted">{hint}</span>}
        </div>
      )}

      <div
        role="progressbar"
        aria-label={label ?? 'Progreso'}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
        aria-valuetext={indeterminate ? 'Trabajando' : `${Math.round(clamped)}%`}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-line',
          size === 'md' ? 'h-2' : 'h-1.5',
        )}
      >
        {indeterminate ? (
          <span
            data-motion-essential
            aria-hidden="true"
            className={cn('absolute inset-y-0 w-1/3 animate-sweep rounded-full', TONE_SOLID_BG[tone])}
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              'block h-full rounded-full transition-[width] duration-500 ease-out-soft',
              TONE_SOLID_BG[tone],
            )}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  )
}

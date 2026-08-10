import type { ReactNode } from 'react'
import { Ban, Lock, OctagonAlert, ScanSearch, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ErrorKind = 'error' | 'forbidden' | 'not-found' | 'job-failed' | 'offline'

/**
 * Textos por defecto. Dicen qué pasó y qué hacer, sin culpar al usuario
 * y sin jerga. Cualquier pantalla puede pisarlos con `title`/`description`.
 */
const PRESETS: Record<ErrorKind, { icon: ReactNode; title: string; description: string }> = {
  error: {
    icon: <OctagonAlert strokeWidth={1.7} />,
    title: 'Algo se rompió de nuestro lado',
    description: 'No es tu proyecto: es nuestro. Probá de nuevo en un minuto.',
  },
  forbidden: {
    icon: <Lock strokeWidth={1.7} />,
    title: 'No tenés acceso a esto',
    description: 'Pedile a quien administra el espacio de trabajo que te dé permiso.',
  },
  'not-found': {
    icon: <ScanSearch strokeWidth={1.7} />,
    title: 'No encontramos esto',
    description: 'Puede que lo hayan borrado, o que el link esté mal copiado.',
  },
  'job-failed': {
    icon: <Unplug strokeWidth={1.7} />,
    title: 'El análisis se cortó a mitad de camino',
    description: 'Lo que ya se revisó quedó guardado. Podés retomarlo desde donde quedó.',
  },
  offline: {
    icon: <Ban strokeWidth={1.7} />,
    title: 'Perdimos la conexión',
    description: 'Revisá tu internet. Volvemos a intentar solos cuando vuelva.',
  },
}

export interface ErrorStateProps {
  kind?: ErrorKind
  title?: string
  description?: ReactNode
  /** Botón de reintento o de salida. Siempre tiene que haber una salida. */
  action?: ReactNode
  secondaryAction?: ReactNode
  /**
   * Detalle técnico. Va colapsado: al usuario no le sirve, pero si nos
   * escribe queremos que lo pueda copiar.
   */
  detail?: string
  className?: string
}

export function ErrorState({
  kind = 'error',
  title,
  description,
  action,
  secondaryAction,
  detail,
  className,
}: ErrorStateProps) {
  const preset = PRESETS[kind]

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-line bg-surface',
        'px-6 py-14 text-center shadow-support sm:py-16',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mb-5 flex size-14 items-center justify-center rounded-full',
          kind === 'error' || kind === 'job-failed'
            ? 'bg-expuesto-soft text-expuesto-text'
            : 'bg-canvas-sunken text-ink-muted',
          '[&_svg]:size-6',
        )}
      >
        {preset.icon}
      </span>

      <h3 className="text-xl font-semibold text-balance text-ink">{title ?? preset.title}</h3>
      <p className="mt-2 max-w-prose text-base leading-relaxed text-balance text-ink-muted">
        {description ?? preset.description}
      </p>

      {(action || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}

      {detail && (
        <details className="mt-8 w-full max-w-prose text-left">
          <summary className="cursor-pointer list-none text-sm text-ink-subtle underline underline-offset-4 hover:text-ink-muted focus-visible:focus-ring">
            Ver el detalle técnico
          </summary>
          <pre className="mt-3 max-h-48 overflow-auto rounded-sm bg-canvas-sunken p-3 font-mono text-xs leading-relaxed text-ink-muted">
            {detail}
          </pre>
        </details>
      )}
    </div>
  )
}

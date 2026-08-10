import type { ComponentPropsWithRef, ReactNode } from 'react'
import { CircleCheck, CircleQuestionMark, Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TONE_BORDER, TONE_SOFT_BG, TONE_TEXT, type Tone } from './severity'

const ICONS: Record<Tone, typeof Info> = {
  expuesto: OctagonAlert,
  incompleto: TriangleAlert,
  verificado: CircleCheck,
  revisar: CircleQuestionMark,
  neutral: Info,
}

export interface CalloutProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  tone?: Tone
  title?: ReactNode
  /** Reemplaza el ícono por defecto del tono. */
  icon?: ReactNode
  /** Botón o link al final del bloque. */
  action?: ReactNode
}

/**
 * Aviso en línea, dentro del flujo de lectura.
 * Para el descargo legal ("esto es lo que un revisor podría marcar"),
 * para el aviso de costo antes de gastar, para "no tocamos tu base".
 */
export function Callout({
  tone = 'neutral',
  title,
  icon,
  action,
  className,
  children,
  ...props
}: CalloutProps) {
  const Icon = ICONS[tone]

  return (
    <div
      role={tone === 'expuesto' ? 'alert' : undefined}
      className={cn(
        'flex gap-3 rounded-md border p-4',
        TONE_SOFT_BG[tone],
        TONE_BORDER[tone],
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn('mt-px shrink-0', TONE_TEXT[tone])}>
        {icon ?? <Icon className="size-[1.15rem]" strokeWidth={1.9} />}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {title && <p className={cn('text-base font-semibold', TONE_TEXT[tone])}>{title}</p>}
        {children && <div className="text-sm leading-relaxed text-ink-muted">{children}</div>}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  )
}

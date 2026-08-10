import type { ComponentPropsWithRef, ElementType, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TONE_BORDER, TONE_EDGE, TONE_SOFT_BG, type Tone } from './severity'

/**
 * Contenedor de contenido.
 *
 * `emphasis` decide cuánto pesa visualmente. Es lo que hace que un hallazgo
 * grave y uno menor no se vean iguales aunque tengan el mismo texto:
 *
 *   stamp   → fondo teñido + marca gruesa al margen + sombra del tono.
 *   marked  → superficie normal + marca fina al margen.
 *   plain   → superficie normal. Sin marca.
 *   flat    → sin sombra ni borde. Para agrupar dentro de otra tarjeta.
 */
export type CardEmphasis = 'stamp' | 'marked' | 'plain' | 'flat'

export interface CardProps extends ComponentPropsWithRef<'div'> {
  as?: ElementType
  tone?: Tone
  emphasis?: CardEmphasis
  /** Se comporta como un objeto clickeable: hover, cursor, foco. */
  interactive?: boolean
}

export function Card({
  as: Tag = 'div',
  tone = 'neutral',
  emphasis = 'plain',
  interactive = false,
  className,
  children,
  ...props
}: CardProps) {
  const marked = emphasis === 'stamp' || emphasis === 'marked'

  return (
    <Tag
      data-emphasis={emphasis}
      data-tone={tone}
      className={cn(
        'relative rounded-lg',
        emphasis !== 'flat' && 'border',
        emphasis === 'stamp'
          ? cn(TONE_SOFT_BG[tone], TONE_BORDER[tone], tone === 'expuesto' ? 'shadow-stamp' : 'shadow-support')
          : emphasis === 'flat'
            ? 'bg-transparent'
            : 'bg-surface border-line shadow-support',
        marked && [
          'overflow-hidden',
          'before:absolute before:inset-y-0 before:left-0 before:rounded-l-lg',
          emphasis === 'stamp' ? 'before:w-1.5' : 'before:w-[3px]',
          TONE_EDGE[tone],
        ],
        interactive &&
          'transition-[box-shadow,border-color,transform] duration-200 ease-out-soft ' +
            'hover:-translate-y-px hover:shadow-raised focus-within:focus-ring',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  )
}

export function CardHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-5 pb-3 sm:p-6 sm:pb-3.5', className)} {...props} />
}

export function CardTitle({
  as: Tag = 'h3',
  className,
  ...props
}: ComponentPropsWithRef<'h3'> & { as?: ElementType }) {
  return <Tag className={cn('text-xl font-semibold text-ink', className)} {...props} />
}

/** Título de peso máximo: familia display. Para el hallazgo destacado. */
export function CardHeadline({
  as: Tag = 'h2',
  className,
  ...props
}: ComponentPropsWithRef<'h2'> & { as?: ElementType }) {
  return <Tag className={cn('font-display text-2xl leading-tight text-ink sm:text-3xl', className)} {...props} />
}

export function CardDescription({ className, ...props }: ComponentPropsWithRef<'p'>) {
  return <p className={cn('text-base text-ink-muted', className)} {...props} />
}

export function CardBody({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn(
        // `pt-0` asume que un `CardHeader` ya puso el aire de arriba (su `pb-3`
        // hace de costura entre los dos). Pero cuando `CardBody` es el único
        // contenido de la tarjeta —sin header— ese `pt-0` deja todo pegado al
        // borde. `first:` restaura el padding-top completo solo cuando
        // `CardBody` es el primer hijo de `Card`; si hay un `CardHeader`
        // antes, no matchea y se queda en 0 como corresponde.
        'p-5 pt-0 first:pt-5 sm:p-6 sm:pt-0 sm:first:pt-6',
        className,
      )}
      {...props}
    />
  )
}

export function CardFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 border-t border-line px-5 py-4 sm:px-6',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Doble bisel: carcasa exterior + núcleo interior con radios concéntricos.
 * Reservado para lo que tiene que verse como una pieza física: el reproductor
 * de video de un hallazgo y la evidencia. No lo uses en tarjetas comunes —
 * si todo lleva bisel, deja de significar algo.
 */
export function Bezel({
  className,
  innerClassName,
  children,
}: {
  className?: string
  innerClassName?: string
  children: ReactNode
}) {
  return (
    <div className={cn('bezel-shell', className)}>
      <div className={cn('bezel-core bg-canvas-sunken', innerClassName)}>{children}</div>
    </div>
  )
}

import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SeverityDot } from './severity-dot'
import {
  SEVERITY_LABEL,
  TONE_BORDER,
  TONE_ON_SOLID,
  TONE_SOFT_BG,
  TONE_SOLID_BG,
  TONE_TEXT,
  visualFor,
  type Tone,
} from './severity'
import type { Confidence, FindingStatus, Severity } from '@/lib/types/domain'

export type BadgeVariant = 'soft' | 'solid' | 'outline'

export interface BadgeProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  tone?: Tone
  variant?: BadgeVariant
  size?: 'sm' | 'md'
  /** Muestra la silueta del tono a la izquierda. */
  dot?: boolean
  icon?: ReactNode
  children?: ReactNode
}

const SIZES = {
  sm: 'h-5.5 gap-1 px-2 text-2xs',
  md: 'h-7 gap-1.5 px-2.5 text-xs',
} as const

export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'md',
  dot = false,
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full font-medium whitespace-nowrap',
        SIZES[size],
        variant === 'soft' && cn(TONE_SOFT_BG[tone], TONE_TEXT[tone]),
        variant === 'outline' && cn('border bg-transparent', TONE_BORDER[tone], TONE_TEXT[tone]),
        // El sólido va en versalitas espaciadas: se lee como un sello, no
        // como una etiqueta más.
        variant === 'solid' &&
          cn(TONE_SOLID_BG[tone], TONE_ON_SOLID[tone], 'font-semibold uppercase tracking-[0.09em]'),
        className,
      )}
      {...props}
    >
      {dot && <SeverityDot tone={tone} size="sm" />}
      {icon && (
        <span aria-hidden="true" className="[&_svg]:size-[1.15em]">
          {icon}
        </span>
      )}
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * Insignia de gravedad de un hallazgo. Deriva tono y peso sola: nadie tiene
 * que acordarse de que "critical con confianza baja va en azul".
 */
export function SeverityBadge({
  severity,
  confidence,
  status,
  size = 'md',
  className,
}: {
  severity: Severity
  confidence?: Confidence
  status?: FindingStatus
  size?: 'sm' | 'md'
  className?: string
}) {
  const { tone, emphasis } = visualFor({ severity, confidence, status })
  return (
    <Badge
      tone={tone}
      variant={emphasis === 'stamp' ? 'solid' : 'soft'}
      size={size}
      dot={emphasis !== 'stamp'}
      className={className}
    >
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}

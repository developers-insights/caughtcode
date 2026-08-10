import { cn } from '@/lib/utils'
import type { Tone } from './severity'
import { TONE_LABEL } from './severity'

/**
 * La marca chica que identifica el estado de un hallazgo.
 *
 * Cada tono tiene una SILUETA distinta, no solo un color: octógono, triángulo,
 * círculo, anillo con punto, guion. Se distinguen a 10px sin ver el color —
 * que es exactamente lo que necesita alguien que no diferencia rojo de verde.
 */

const SIZES = {
  sm: 'size-2.5',
  md: 'size-3.5',
  lg: 'size-5',
} as const

const FILL: Record<Tone, string> = {
  expuesto: 'fill-expuesto',
  incompleto: 'fill-incompleto',
  verificado: 'fill-verificado',
  revisar: 'fill-revisar',
  neutral: 'fill-ink-subtle',
}

const STROKE: Record<Tone, string> = {
  expuesto: 'stroke-expuesto',
  incompleto: 'stroke-incompleto',
  verificado: 'stroke-verificado',
  revisar: 'stroke-revisar',
  neutral: 'stroke-ink-subtle',
}

export interface SeverityDotProps {
  tone: Tone
  size?: keyof typeof SIZES
  /** Late suave. Solo para "esto está pasando ahora", nunca decorativo. */
  pulse?: boolean
  /** Por defecto es decorativo. Pasá `labelled` si va solo, sin texto al lado. */
  labelled?: boolean
  className?: string
}

export function SeverityDot({
  tone,
  size = 'md',
  pulse = false,
  labelled = false,
  className,
}: SeverityDotProps) {
  const shared = cn('shrink-0', SIZES[size], pulse && 'animate-pulse-stamp', className)
  const a11y = labelled
    ? ({ role: 'img', 'aria-label': TONE_LABEL[tone] } as const)
    : ({ 'aria-hidden': true } as const)

  return (
    <svg viewBox="0 0 16 16" className={shared} {...a11y}>
      {tone === 'expuesto' && (
        <polygon
          points="14.01,10.49 10.49,14.01 5.51,14.01 1.99,10.49 1.99,5.51 5.51,1.99 10.49,1.99 14.01,5.51"
          className={FILL.expuesto}
        />
      )}

      {tone === 'incompleto' && (
        <path
          d="M8 1.9 15 14.2 H1 Z"
          className={cn(FILL.incompleto, STROKE.incompleto)}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      )}

      {tone === 'verificado' && (
        <>
          <circle cx="8" cy="8" r="6.4" className={FILL.verificado} />
          {/* El tilde calado separa el círculo verde del octógono rojo
              incluso en escala de grises. */}
          {size !== 'sm' && (
            <path
              d="M4.9 8.2 7 10.3 11.1 5.9"
              fill="none"
              stroke="var(--cc-verificado-on-solid)"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </>
      )}

      {tone === 'revisar' && (
        <>
          <circle cx="8" cy="8" r="5.6" fill="none" className={STROKE.revisar} strokeWidth="2.2" />
          <circle cx="8" cy="8" r="1.9" className={FILL.revisar} />
        </>
      )}

      {tone === 'neutral' && <rect x="1.6" y="6.7" width="12.8" height="2.6" rx="1.3" className={FILL.neutral} />}
    </svg>
  )
}

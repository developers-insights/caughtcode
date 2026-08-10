import { cn } from '@/lib/utils'

const SIZES = {
  xs: 'size-3.5 border-[1.5px]',
  sm: 'size-4 border-2',
  md: 'size-5 border-2',
  lg: 'size-8 border-[2.5px]',
} as const

export interface SpinnerProps {
  size?: keyof typeof SIZES
  className?: string
  /** Texto para lectores de pantalla. Poné uno si el spinner está solo. */
  label?: string
}

/**
 * Indicador de "esto está trabajando".
 * Sigue girando (más lento) con prefers-reduced-motion: un spinner quieto
 * le dice al usuario que la app se colgó.
 */
export function Spinner({ size = 'md', className, label }: SpinnerProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        data-motion-essential
        aria-hidden="true"
        className={cn(
          'inline-block shrink-0 animate-spin rounded-full',
          'border-current/25 border-t-current',
          SIZES[size],
        )}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

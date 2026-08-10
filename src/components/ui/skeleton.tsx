import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

export interface SkeletonProps extends ComponentPropsWithRef<'div'> {
  /** Reserva el alto exacto del contenido real para que nada salte al cargar. */
  lines?: number
}

/**
 * Hueco con la forma de lo que va a llegar.
 * Siempre reserva el espacio real: si el bloque salta cuando llega el dato,
 * es peor que no mostrar nada.
 */
export function Skeleton({ className, lines, ...props }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <div className={cn('space-y-2', className)} aria-hidden="true" {...props}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-4 animate-shimmer rounded-xs bg-line',
              i === lines - 1 && 'w-3/5',
            )}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      aria-hidden="true"
      className={cn('animate-shimmer rounded-sm bg-line', className)}
      {...props}
    />
  )
}

/** Tarjeta fantasma con la silueta de un hallazgo de la lista. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-surface p-5 shadow-support', className)}
      aria-hidden="true"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-3.5 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="mt-4 h-6 w-4/5" />
      <Skeleton lines={2} className="mt-3" />
    </div>
  )
}

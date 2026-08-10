import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  /** Una frase que diga qué hacer, no solo que está vacío. */
  description?: ReactNode
  action?: ReactNode
  secondaryAction?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Pantalla vacía. Nunca queda en blanco: siempre dice qué falta y qué hacer.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong',
        'bg-canvas-sunken/60 text-center',
        size === 'md' ? 'px-6 py-14 sm:py-20' : 'px-5 py-10',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mb-5 flex items-center justify-center rounded-full bg-surface text-ink-subtle shadow-support',
          size === 'md' ? 'size-14 [&_svg]:size-6' : 'size-11 [&_svg]:size-5',
        )}
      >
        {icon ?? <Inbox strokeWidth={1.6} />}
      </span>

      <h3 className={cn('font-semibold text-ink', size === 'md' ? 'text-xl' : 'text-base')}>{title}</h3>

      {description && (
        <p className="mt-2 max-w-prose text-base leading-relaxed text-balance text-ink-muted">
          {description}
        </p>
      )}

      {(action || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  )
}

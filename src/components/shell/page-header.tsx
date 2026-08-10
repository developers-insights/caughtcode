import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface Crumb {
  label: string
  href?: string
}

export interface PageHeaderProps {
  title: ReactNode
  /** Una frase que diga de qué va la pantalla. Opcional pero recomendada. */
  description?: ReactNode
  /** Migas de pan. Desde 3 niveles de profundidad son obligatorias. */
  crumbs?: Crumb[]
  /** Etiqueta microscópica arriba del título. Ej. "Seguridad". */
  eyebrow?: string
  /** Acción principal. Solo UNA por pantalla. */
  action?: ReactNode
  /** Acciones secundarias, visualmente subordinadas. */
  secondaryActions?: ReactNode
  /** Insignias de estado a la derecha del título. */
  meta?: ReactNode
  /** Título con la familia display. Para pantallas de hallazgo. */
  display?: boolean
  className?: string
}

export function PageHeader({
  title,
  description,
  crumbs,
  eyebrow,
  action,
  secondaryActions,
  meta,
  display = false,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('mb-8', className)}>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Dónde estás" className="mb-3">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-muted">
            {crumbs.map((crumb, i) => (
              <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && (
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-subtle" />
                )}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="rounded-xs underline-offset-4 hover:text-ink hover:underline focus-visible:focus-ring"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-ink">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          {eyebrow && <p className="mb-2 text-eyebrow uppercase text-ink-subtle">{eyebrow}</p>}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1
              className={cn(
                'min-w-0 text-balance text-ink',
                display
                  ? 'font-display text-3xl leading-tight sm:text-4xl'
                  : 'text-2xl font-semibold',
              )}
            >
              {title}
            </h1>
            {meta}
          </div>

          {description && (
            <p className="mt-2 max-w-prose text-lg leading-relaxed text-ink-muted">{description}</p>
          )}
        </div>

        {(action || secondaryActions) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2.5">
            {secondaryActions}
            {action}
          </div>
        )}
      </div>
    </div>
  )
}

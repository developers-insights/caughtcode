import { ShieldCheck } from 'lucide-react'
import { COMENTARIOS } from '@/content/copy'
import { cn } from '@/lib/utils'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import type { CleanMode } from './model-clean'
import type { FuncionalesResumen } from './model'

const n = (x: number) => x.toLocaleString('es-AR')

export interface FunctionalCommentsPanelProps {
  funcionales: FuncionalesResumen
  mode: CleanMode
  className?: string
}

/**
 * Lo que no se borra, y por qué.
 *
 * Este panel no es un detalle: es la razón por la que alguien se anima a
 * apretar el botón. Una herramienta que sabe distinguir un comentario que
 * explica de uno que hace algo es una herramienta en la que se puede confiar.
 */
export function FunctionalCommentsPanel({
  funcionales,
  mode,
  className,
}: FunctionalCommentsPanelProps) {
  if (funcionales.total === 0) return null

  return (
    <Card className={cn('bg-canvas-sunken/40', className)}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-ink-subtle" strokeWidth={1.9} />
          <CardTitle as="h2" className="text-base">
            {n(funcionales.total)}{' '}
            {funcionales.total === 1 ? 'comentario que no se borra' : 'comentarios que no se borran'}
          </CardTitle>
        </div>
        <p className="max-w-prose text-base leading-relaxed text-ink-muted">
          Tu proyecto los necesita para funcionar. Los dejamos donde están aunque elijas sacar todo.
        </p>
      </CardHeader>

      <CardBody>
        <ul className="divide-y divide-line">
          {funcionales.motivos.map(({ reason, count }) => (
            <li key={reason} className="flex items-baseline gap-4 py-3">
              <span className="w-12 shrink-0 text-right text-base font-semibold tabular text-ink">
                {n(count)}
              </span>
              <span className="min-w-0 flex-1 text-base leading-snug text-ink-muted">{reason}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-ink-muted">
          {mode === 'safe'
            ? 'Con la limpieza segura se conservan todos.'
            : COMENTARIOS.modos.aggressive.texto}
        </p>
      </CardBody>
    </Card>
  )
}

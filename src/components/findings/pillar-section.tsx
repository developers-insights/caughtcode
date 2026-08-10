import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SeverityDot, visualFor } from '@/components/ui'
import type { Finding } from '@/lib/types/domain'
import { LISTA } from './copy'
import { FindingCard } from './finding-card'

export interface PillarSectionProps {
  titulo: string
  hallazgos: Finding[]
  hrefDe: (finding: Finding) => string
  /** Abierto de entrada. Por defecto no: esto vive en segundo plano. */
  abiertoPorDefecto?: boolean
  className?: string
}

/**
 * Un área plegada.
 *
 * Es `<details>` a propósito: abre y cierra sin JavaScript, se navega con el
 * teclado sin que tengamos que escribirlo, y el buscador del navegador lo
 * encuentra igual. Que esté cerrado por defecto es la regla de producto —
 * acá vive lo que no hay que hacer hoy.
 */
export function PillarSection({
  titulo,
  hallazgos,
  hrefDe,
  abiertoPorDefecto = false,
  className,
}: PillarSectionProps) {
  if (hallazgos.length === 0) return null

  // Resumen sin abrir: qué siluetas hay adentro, de la más grave a la menos.
  const siluetas = hallazgos.slice(0, 6).map((f) => ({ id: f.id, tone: visualFor(f).tone }))

  return (
    <details
      open={abiertoPorDefecto}
      className={cn(
        'group overflow-hidden rounded-lg border border-line bg-surface shadow-support',
        className,
      )}
    >
      <summary
        className={cn(
          'flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 sm:px-5',
          'transition-colors duration-150 ease-firm hover:bg-surface-hover',
          'focus-visible:focus-ring-inset [&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.8}
          className="size-4 shrink-0 text-ink-subtle transition-transform duration-200 ease-firm group-open:rotate-90"
        />

        <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{titulo}</span>

        <span aria-hidden="true" className="hidden items-center gap-1 sm:flex">
          {siluetas.map((s) => (
            <SeverityDot key={s.id} tone={s.tone} size="sm" />
          ))}
          {hallazgos.length > siluetas.length && (
            <span className="ml-1 text-2xs text-ink-subtle">
              +{hallazgos.length - siluetas.length}
            </span>
          )}
        </span>

        <span className="shrink-0 text-sm text-ink-muted tabular">
          {LISTA.resto.conteo(hallazgos.length)}
        </span>
      </summary>

      <div className="border-t border-line p-1.5">
        <ul className="flex flex-col">
          {hallazgos.map((finding) => (
            <li key={finding.id}>
              <FindingCard finding={finding} href={hrefDe(finding)} variante="compacto" />
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

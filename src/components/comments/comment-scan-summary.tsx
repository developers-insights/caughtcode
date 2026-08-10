import type { ReactNode } from 'react'
import { Globe, Laptop, Server, type LucideIcon } from 'lucide-react'
import type { CommentReach } from '@/lib/types/domain'
import { cn } from '@/lib/utils'
import {
  Card,
  CardBody,
  CardHeader,
  CardHeadline,
  TONE_SOLID_BG,
  TONE_TEXT,
  type Tone,
} from '@/components/ui'
import { repartoPorAlcance, veredicto, type CommentsViewModel } from './model'

export const ICONO_ALCANCE: Record<CommentReach, LucideIcon> = {
  ships_to_browser: Globe,
  server_only: Server,
  build_only: Laptop,
}

/**
 * Peso visual descendente, de arriba hacia abajo: lo que sale del sitio se ve,
 * lo que se queda adentro acompaña. La barra enseña el reparto sin nombrarlo.
 */
const RELLENO_ALCANCE: Record<CommentReach, string> = {
  ships_to_browser: '',
  server_only: 'bg-ink-subtle',
  build_only: 'bg-line-strong',
}

const n = (x: number) => x.toLocaleString('es-AR')

export interface CommentScanSummaryProps {
  modelo: CommentsViewModel
  /**
   * Acción secundaria — volver a revisar. Va acá y no en el encabezado porque
   * en celular los botones se apilan, y la acción principal tiene que quedar
   * primero. Además es donde tiene sentido: al lado de los números que rehace.
   */
  action?: ReactNode
  className?: string
}

/**
 * El veredicto de la pantalla.
 *
 * Una frase que se lee de lejos y una barra que muestra el reparto: cuánto de
 * lo que escribiste sale a la calle y cuánto se queda adentro. El número que
 * manda no es "cuántos comentarios tenés", es "cuántos los ve cualquiera".
 */
export function CommentScanSummary({ modelo, action, className }: CommentScanSummaryProps) {
  const v = veredicto(modelo)
  const reparto = repartoPorAlcance(modelo)
  const grave = v.tone === 'expuesto'

  return (
    <Card
      tone={v.tone}
      emphasis={grave ? 'stamp' : 'marked'}
      className={cn('overflow-hidden', className)}
    >
      <CardHeader className="gap-3">
        <p className="text-eyebrow uppercase text-ink-subtle">
          {n(modelo.scannedFiles)} archivos revisados
        </p>
        <CardHeadline className="text-balance">{v.titular}</CardHeadline>
        <p className="max-w-prose text-lg leading-relaxed text-ink-muted">{v.apoyo}</p>
      </CardHeader>

      <CardBody className="pt-2">
        {modelo.total > 0 && (
          <>
            <div
              aria-hidden="true"
              className="flex h-2.5 w-full gap-1 overflow-hidden rounded-full"
            >
              {reparto
                .filter((r) => r.total > 0)
                .map((r) => (
                  <span
                    key={r.reach}
                    className={cn(
                      'block h-full rounded-full',
                      r.reach === 'ships_to_browser'
                        ? TONE_SOLID_BG[v.tone]
                        : RELLENO_ALCANCE[r.reach],
                    )}
                    // Piso de 6% para que un tramo chico se siga viendo.
                    style={{ width: `${Math.max(r.porcentaje, 6)}%` }}
                  />
                ))}
            </div>

            {/* La leyenda dice todo lo que dice la barra, en texto: nadie
                depende del color para entenderla. */}
            <ul className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
              {reparto.map((r) => {
                const Icono = ICONO_ALCANCE[r.reach]
                const expuesto = r.reach === 'ships_to_browser'
                const tono: Tone = expuesto ? v.tone : 'neutral'

                return (
                  <li key={r.reach} className="flex items-start gap-2.5">
                    <Icono
                      aria-hidden="true"
                      className={cn('mt-0.5 size-4 shrink-0', expuesto ? TONE_TEXT[tono] : 'text-ink-subtle')}
                      strokeWidth={1.9}
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'block text-xl font-semibold tabular',
                          expuesto ? TONE_TEXT[tono] : 'text-ink',
                        )}
                      >
                        {n(r.total)}
                      </span>
                      <span className="block text-sm leading-snug text-ink-muted">{r.titulo}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {action && <div className="mt-5 border-t border-line pt-4">{action}</div>}
      </CardBody>
    </Card>
  )
}

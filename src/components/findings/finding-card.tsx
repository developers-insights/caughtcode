import Link from 'next/link'
import { ArrowRight, ChevronRight, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardHeadline,
  CopyButton,
  buttonStyles,
  visualFor,
  type CardEmphasis,
  type Emphasis,
} from '@/components/ui'
import type { Finding } from '@/lib/types/domain'
import { PILLAR_LABEL } from '@/lib/types/domain'
import { ARREGLO, TARJETA } from './copy'
import { SeverityIndicator } from './severity-indicator'
import type { FindingVideo } from './view'

/** El peso que devuelve `visualFor` traducido al que entiende `<Card>`. */
export function emphasisDeTarjeta(emphasis: Emphasis): CardEmphasis {
  return emphasis === 'stamp' ? 'stamp' : emphasis === 'marked' ? 'marked' : 'plain'
}

export interface FindingCardProps {
  finding: Finding
  href: string
  video?: FindingVideo | null
  /**
   *  destacado — tarjeta grande, título en serif, explicación y consecuencia
   *              a la vista, acciones al pie. Como mucho tres por pantalla.
   *  compacto  — una fila. Silueta, título y a dónde lleva. Nada más.
   *
   * No son la misma tarjeta con otro tamaño: son dos objetos distintos, y esa
   * es la idea. Se tienen que distinguir sin leer.
   */
  variante: 'destacado' | 'compacto'
  /** Posición 1..3 en la lista de urgentes. Solo para `destacado`. */
  posicion?: number
  className?: string
}

export function FindingCard(props: FindingCardProps) {
  return props.variante === 'destacado' ? <Destacado {...props} /> : <Compacto {...props} />
}

/* ── Destacado ─────────────────────────────────────────────────────────── */

function Destacado({ finding, href, video, posicion, className }: FindingCardProps) {
  const { tone, emphasis } = visualFor(finding)
  const grave = emphasis === 'stamp'
  const hayVideo = video?.status === 'ready'

  return (
    <Card
      as="article"
      tone={tone}
      emphasis={emphasisDeTarjeta(emphasis)}
      className={cn(grave && 'sm:pl-1', className)}
    >
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {posicion !== undefined && (
            <span
              aria-label={TARJETA.posicion(posicion)}
              className={cn(
                'font-display text-2xl leading-none tabular',
                grave ? 'text-expuesto-text' : 'text-ink-subtle',
              )}
            >
              {posicion}
            </span>
          )}
          <SeverityIndicator
            severity={finding.severity}
            confidence={finding.confidence}
            status={finding.status}
            variante={grave ? 'fuerte' : 'suave'}
          />
          <span className="text-eyebrow uppercase text-ink-subtle">
            {PILLAR_LABEL[finding.pillar]}
          </span>
        </div>

        <CardHeadline as="h3" className={cn(!grave && 'text-xl font-normal sm:text-2xl')}>
          <Link
            href={href}
            className="rounded-xs underline-offset-[6px] hover:underline focus-visible:focus-ring"
          >
            {finding.titlePlain}
          </Link>
        </CardHeadline>
      </CardHeader>

      <CardBody className="space-y-4">
        <p className="prose-lectura text-lg text-ink-muted">{finding.explanationPlain}</p>

        <div
          className={cn(
            'rounded-md border-l-[3px] py-1 pl-4',
            grave ? 'border-expuesto' : 'border-line-strong',
          )}
        >
          <p className="text-eyebrow uppercase text-ink-subtle">{TARJETA.quePuedePasar}</p>
          <p className="mt-1 text-base text-ink">{finding.impactPlain}</p>
        </div>
      </CardBody>

      <CardFooter className={cn(grave && 'border-expuesto-border')}>
        <Link
          href={href}
          className={buttonStyles({ variant: grave ? 'primary' : 'secondary', size: 'md' })}
        >
          {hayVideo ? (
            <>
              <Play aria-hidden="true" strokeWidth={1.8} className="size-4" />
              {TARJETA.verDemostracion}
            </>
          ) : (
            <>
              {TARJETA.verDetalle}
              <ArrowRight aria-hidden="true" strokeWidth={1.8} className="size-4" />
            </>
          )}
        </Link>

        <CopyButton value={finding.fixPrompt} label={ARREGLO.copiar} variant="ghost" size="md" />
      </CardFooter>
    </Card>
  )
}

/* ── Compacto ──────────────────────────────────────────────────────────── */

function Compacto({ finding, href, className }: FindingCardProps) {
  const resuelto = finding.status !== 'open'

  return (
    <Link
      href={href}
      className={cn(
        'group flex min-h-11 items-center gap-3 rounded-sm px-3 py-2.5',
        'transition-colors duration-150 ease-firm hover:bg-surface-hover focus-visible:focus-ring',
        className,
      )}
    >
      <SeverityIndicator
        severity={finding.severity}
        confidence={finding.confidence}
        status={finding.status}
        variante="punto"
        className="w-24 shrink-0 sm:w-28"
      />

      <span
        className={cn(
          'min-w-0 flex-1 text-base',
          resuelto ? 'text-ink-muted line-through decoration-line-strong' : 'text-ink',
        )}
      >
        {finding.titlePlain}
      </span>

      <ChevronRight
        aria-hidden="true"
        strokeWidth={1.8}
        className="size-4 shrink-0 text-ink-subtle transition-transform duration-150 ease-firm group-hover:translate-x-0.5 group-hover:text-ink-muted"
      />
    </Link>
  )
}

import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Card, CardBody, CardHeader, TONE_TEXT } from '@/components/ui'
import { tonoDelGrupo, type ReachGroup } from './model'
import { CommentRow } from './comment-row'
import { ICONO_ALCANCE } from './comment-scan-summary'

const n = (x: number) => x.toLocaleString('es-AR')

/**
 * Cuánto pesa cada alcance en la pantalla.
 *
 * Esto es la lección, hecha maqueta: lo que sale del sitio va arriba y ocupa
 * lugar; lo que se queda adentro acompaña; lo que ni siquiera se publica está
 * plegado. Nadie tiene que leer una explicación para entender el orden.
 */
type Peso = 'principal' | 'secundario' | 'plegado'

const PESO: Record<ReachGroup['reach'], Peso> = {
  ships_to_browser: 'principal',
  server_only: 'secundario',
  build_only: 'plegado',
}

export interface ReachSectionProps {
  grupo: ReachGroup
  className?: string
}

function ListaDeFilas({ grupo }: { grupo: ReachGroup }) {
  return (
    <>
      <ul className="divide-y divide-line">
        {grupo.destacados.map((fila) => (
          <CommentRow key={fila.id} fila={fila} />
        ))}
      </ul>

      {grupo.resto.length > 0 && (
        <details className="group mt-2 border-t border-line pt-2">
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-2 rounded-sm py-2.5 pl-4',
              'text-base text-ink-muted select-none hover:text-ink focus-visible:focus-ring',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform duration-200 ease-out-soft group-open:rotate-90"
              strokeWidth={2}
            />
            Ver {grupo.ocultos > 0 ? `${n(grupo.resto.length)} más` : `los otros ${n(grupo.resto.length)}`}
          </summary>
          <ul className="divide-y divide-line">
            {grupo.resto.map((fila) => (
              <CommentRow key={fila.id} fila={fila} />
            ))}
          </ul>
          {grupo.ocultos > 0 && (
            <p className="border-t border-line px-4 py-3 text-sm text-ink-muted">
              Hay {n(grupo.ocultos)} más que no listamos acá para que la página siga siendo
              usable. Entran igual cuando saques los comentarios.
            </p>
          )}
        </details>
      )}
    </>
  )
}

/**
 * Un alcance completo: quiénes lo leen, cuántos son y cuáles.
 *
 * Solo el grupo que sale del sitio puede tomar color, y lo toma por lo que
 * dicen sus comentarios. Los otros dos son neutros a propósito: un comentario
 * que se queda en tu servidor no es un problema, y esta pantalla no puede
 * insinuar que lo sea.
 */
export function ReachSection({ grupo, className }: ReachSectionProps) {
  if (grupo.total === 0) return null

  const peso = PESO[grupo.reach]
  const tone = tonoDelGrupo(grupo)
  const Icono = ICONO_ALCANCE[grupo.reach]
  const conColor = grupo.reach === 'ships_to_browser' && grupo.sensibles > 0

  if (peso === 'plegado') {
    return (
      <details className={cn('group rounded-lg border border-line bg-canvas-sunken/50', className)}>
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center gap-3 rounded-lg p-4',
            'select-none hover:bg-surface-hover focus-visible:focus-ring',
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-ink-subtle transition-transform duration-200 ease-out-soft group-open:rotate-90"
            strokeWidth={2}
          />
          <Icono aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" strokeWidth={1.9} />
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium text-ink">{grupo.titulo}</span>
            <span className="block text-sm text-ink-muted">{grupo.quienLoLee}</span>
          </span>
          <span className="shrink-0 text-base tabular text-ink-muted">{n(grupo.total)}</span>
        </summary>

        <div className="border-t border-line px-2 pt-1 pb-3">
          <ListaDeFilas grupo={grupo} />
        </div>
      </details>
    )
  }

  return (
    <Card
      as="section"
      tone={tone}
      emphasis={conColor ? 'marked' : 'plain'}
      className={cn(peso === 'secundario' && 'bg-canvas-sunken/40', className)}
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Icono
            aria-hidden="true"
            className={cn('size-5 shrink-0', conColor ? TONE_TEXT[tone] : 'text-ink-subtle')}
            strokeWidth={1.9}
          />
          <h2
            className={cn(
              'min-w-0 font-semibold text-ink',
              peso === 'principal' ? 'text-xl' : 'text-base',
            )}
          >
            {grupo.titulo}
          </h2>
          <Badge tone={conColor ? tone : 'neutral'} size="sm" className="tabular">
            {n(grupo.total)}
          </Badge>
          {/* La cuenta de riesgo es solo del grupo que sale del sitio. En los
              otros dos sería inventarles un problema: nadie de afuera los lee. */}
          {conColor && (
            <Badge tone={tone} variant="outline" size="sm">
              {grupo.sensibles === 1
                ? '1 dice algo de más'
                : `${n(grupo.sensibles)} dicen algo de más`}
            </Badge>
          )}
        </div>

        <p className={cn('max-w-prose leading-relaxed text-ink-muted', peso === 'principal' ? 'text-lg' : 'text-base')}>
          {grupo.quienLoLee}
        </p>
      </CardHeader>

      <CardBody className="px-1 sm:px-2">
        <ListaDeFilas grupo={grupo} />
      </CardBody>
    </Card>
  )
}

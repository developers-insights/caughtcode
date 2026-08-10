import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SeverityDot, TONE_EDGE, TONE_TEXT } from '@/components/ui'
import { esRiesgoso, esSensible, tonoDeRiesgo, type CommentRowModel } from './model'
import { redactar } from './redact'
import { RiskBadge } from './risk-badge'

export interface CommentRowProps {
  fila: CommentRowModel
  /** Oculta el archivo cuando la fila ya vive adentro de un archivo. */
  hideFile?: boolean
  className?: string
}

/** El nombre del archivo pesa; la carpeta acompaña. */
function partirRuta(file: string): { carpeta: string; nombre: string } {
  const corte = file.lastIndexOf('/')
  return corte === -1
    ? { carpeta: '', nombre: file }
    : { carpeta: file.slice(0, corte + 1), nombre: file.slice(corte + 1) }
}

/**
 * Un comentario encontrado.
 *
 * El texto llega ya enmascarado desde el servidor: si tenía algo que parece una
 * clave, lo que se ve es `sk_live_••••4242`. El valor completo no entra nunca
 * en esta capa — no tiene sentido avisar de una filtración copiándola de nuevo.
 */
export function CommentRow({ fila, hideFile = false, className }: CommentRowProps) {
  // El color solo aparece donde el comentario puede hacer daño: cuando sale del
  // sitio Y dice algo que no debería leerse. Un pendiente a la vista, o una
  // nota interna que se queda en tu servidor, se nombran igual pero en gris.
  const sale = fila.reach === 'ships_to_browser'
  const riesgoso = sale && esSensible(fila.risk)
  const tone = riesgoso ? tonoDeRiesgo(fila.risk) : 'neutral'
  const { carpeta, nombre } = partirRuta(fila.file)
  const rango = fila.endLine > fila.line ? `${fila.line}–${fila.endLine}` : String(fila.line)

  return (
    <li
      className={cn(
        'relative rounded-sm py-3 pr-1',
        riesgoso
          ? cn(
              'overflow-hidden pl-4',
              'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full',
              TONE_EDGE[tone],
            )
          : 'pl-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {esRiesgoso(fila.risk) ? (
          <RiskBadge risk={fila.risk} tone={tone} />
        ) : (
          <SeverityDot tone="neutral" size="sm" className="opacity-70" />
        )}

        {!hideFile && (
          <span className="min-w-0 font-mono text-xs text-ink-subtle" title={`${fila.file}:${rango}`}>
            <span className="hidden sm:inline">{carpeta}</span>
            <span className="text-ink-muted">{nombre}</span>
            <span className="tabular">:{rango}</span>
          </span>
        )}

        {hideFile && <span className="font-mono text-xs tabular text-ink-subtle">línea {rango}</span>}

        {fila.functional && (
          <span className="inline-flex items-center gap-1 text-2xs text-ink-subtle">
            <Lock aria-hidden="true" className="size-3" strokeWidth={2} />
            No se borra
          </span>
        )}
      </div>

      <p
        className={cn(
          'mt-1.5 line-clamp-3 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap',
          riesgoso ? 'text-ink' : 'text-ink-muted',
        )}
      >
        {redactar(fila.text)}
      </p>

      {riesgoso && fila.reason && (
        <p className={cn('mt-1.5 text-sm leading-snug', TONE_TEXT[tone])}>{fila.reason}</p>
      )}
    </li>
  )
}

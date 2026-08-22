import { cn } from '@/lib/utils'
import {
  Badge,
  CONFIDENCE_HINT,
  CONFIDENCE_LABEL,
  SeverityDot,
  SEVERITY_LABEL,
  SEVERITY_URGENCY,
  Tooltip,
  visualFor,
} from '@/components/ui'
import type { Confidence, FindingStatus, Severity } from '@/lib/types/domain'
import { DISCLAIMER_CONFIANZA_MEDIA } from '@/content/lenguaje'

export interface SeverityIndicatorProps {
  severity: Severity
  confidence: Confidence
  status: FindingStatus
  /**
   *  fuerte — insignia sólida + urgencia escrita. Para el hallazgo destacado.
   *  suave  — insignia tenue. Para el encabezado de la pantalla de detalle.
   *  punto  — silueta y una palabra. Para las filas de la lista colapsada.
   */
  variante?: 'fuerte' | 'suave' | 'punto'
  className?: string
}

/**
 * Cuán grave es esto, dicho de tres maneras a la vez: color, silueta y
 * palabra. Nunca solo color — hay gente que no distingue rojo de verde, y
 * además el color solo no dice *cuándo* hay que hacerlo.
 */
export function SeverityIndicator({
  severity,
  confidence,
  status,
  variante = 'suave',
  className,
}: SeverityIndicatorProps) {
  const { tone } = visualFor({ severity, confidence, status })

  // Si no hay certeza, la palabra que manda es "a revisar", no la gravedad:
  // afirmar con fuerza algo que no probamos es exactamente lo que no hacemos.
  const dudoso = confidence === 'to_review'
  const etiqueta = dudoso ? CONFIDENCE_LABEL.to_review : SEVERITY_LABEL[severity]

  if (variante === 'punto') {
    return (
      <span className={cn('inline-flex items-center gap-2', className)}>
        <SeverityDot tone={tone} size="sm" />
        <span className="text-xs text-ink-muted">{etiqueta}</span>
      </span>
    )
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2.5 gap-y-1.5', className)}>
      <Badge tone={tone} variant={variante === 'fuerte' ? 'solid' : 'soft'} size="md" dot>
        {etiqueta}
      </Badge>

      {status === 'open' && !dudoso && (
        <span
          className={cn(
            'text-xs',
            severity === 'critical' ? 'font-medium text-expuesto-text' : 'text-ink-muted',
          )}
        >
          {SEVERITY_URGENCY[severity]}
        </span>
      )}

      {/* El disparador del tooltip es un `<button>`, no un `<span tabIndex={0}>`.
          Un span con tabindex se puede enfocar con Tab pero en iOS no se enfoca
          al tocarlo: el tooltip abre con `onFocusCapture`, así que en celular la
          aclaración no aparecía nunca. Con un botón real aparece, y además queda
          el par que pide el patrón ARIA de tooltip: control enfocable +
          `aria-describedby` (lo pone `<Tooltip>` al abrir). */}
      {dudoso ? (
        <Tooltip content={DISCLAIMER_CONFIANZA_MEDIA}>
          <button
            type="button"
            className="rounded-xs text-xs text-ink-muted underline decoration-line-strong decoration-dotted underline-offset-4 focus-visible:focus-ring"
          >
            {CONFIDENCE_HINT.to_review}
          </button>
        </Tooltip>
      ) : (
        variante === 'suave' && (
          <Tooltip content={CONFIDENCE_HINT[confidence]}>
            <button
              type="button"
              className="rounded-xs text-xs text-ink-subtle underline decoration-line decoration-dotted underline-offset-4 focus-visible:focus-ring"
            >
              {CONFIDENCE_LABEL[confidence]}
            </button>
          </Tooltip>
        )
      )}
    </span>
  )
}

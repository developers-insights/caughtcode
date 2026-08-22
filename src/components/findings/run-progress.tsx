import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardBody, Progress } from '@/components/ui'
import { ESTADOS } from '@/content/copy'
import type { ErrorLegible } from '@/content/lenguaje'
import { CORTE, LISTA, PROGRESO } from './copy'
import { TechnicalDetail } from './technical-detail'
import type { RunView } from './view'

export interface RunProgressProps {
  run: RunView
  /** Cuántos hallazgos ya llegaron. Cambia el mensaje de espera. */
  encontrados: number
  /** Se perdió la conexión en vivo: lo decimos en vez de simular que todo va bien. */
  desconectado?: boolean
  className?: string
}

/**
 * Qué está pasando mientras la revisión corre.
 *
 * Nunca una barra girando sola: se muestra la etapa real que reporta el motor
 * y cuántos hallazgos van apareciendo. Si no sabemos cuánto falta, la barra va
 * indeterminada — mentir con un porcentaje inventado es peor que no tenerlo.
 */
export function RunProgress({ run, encontrados, desconectado = false, className }: RunProgressProps) {
  const etapa = run.stage?.trim() || PROGRESO.etapaDesconocida
  const sabemosCuantoFalta = run.progress > 0 && run.progress < 100

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardBody className="space-y-4 pt-5 sm:pt-6">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-ink">{PROGRESO.titulo}</h2>
          <p className="text-base text-ink-muted">{ESTADOS.cargando.texto}</p>
        </div>

        <Progress
          value={sabemosCuantoFalta ? run.progress : undefined}
          label={etapa}
          hint={encontrados > 0 ? PROGRESO.yaAparecieron(encontrados) : PROGRESO.esperando}
        />

        {desconectado && (
          <p
            // `role="status"` es la región viva canónica de ARIA para un aviso
            // que aparece solo. `<output>` nombra el resultado de un cálculo de
            // formulario —otra cosa— y es el idioma que usa toda la pantalla
            // para lo mismo: cambiarlo acá solo rompería la consistencia.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="status"
            className="text-sm text-incompleto-text"
          >
            {PROGRESO.cortado}
          </p>
        )}
      </CardBody>
    </Card>
  )
}

export interface RunPartialNoticeProps {
  className?: string
}

/** La revisión terminó a medias pero hay resultados válidos. */
export function RunPartialNotice({ className }: RunPartialNoticeProps) {
  return (
    <Card tone="incompleto" emphasis="marked" className={className}>
      <CardBody className="space-y-1 pt-5 sm:pt-6">
        <h2 className="text-base font-medium text-ink">{LISTA.parcial.titulo}</h2>
        <p className="text-base text-ink-muted">{LISTA.parcial.texto}</p>
      </CardBody>
    </Card>
  )
}

export interface RunStalledNoticeProps {
  /** Ya había hallazgos guardados cuando se cortó: cambia el texto, no lo esconde. */
  hayHallazgos: boolean
  /** Volver a lanzar la revisión. Mismo botón que usa `RunFailedNotice`. */
  action?: ReactNode
  className?: string
}

/**
 * La base todavía dice "corriendo", pero el trabajo que sostenía la corrida
 * dejó de latir hace más de lo que un proceso vivo dejaría pasar (ver
 * `UMBRAL_SIN_LATIDO_MS` en `view.ts`).
 *
 * Se ve parecida a `RunFailedNotice` a propósito —mismo tono, mismo lugar,
 * misma acción— pero el texto es otro: acá el motor no reportó ningún motivo,
 * así que no hay una caja de "esto fue lo que pasó" que mostrar. Inventar un
 * motivo sería peor que no tener ninguno.
 */
export function RunStalledNotice({ hayHallazgos, action, className }: RunStalledNoticeProps) {
  return (
    <Card tone="incompleto" emphasis="marked" className={className}>
      <CardBody className="space-y-4 pt-5 sm:pt-6">
        <div
          // Acá `<output>` sería HTML inválido: solo admite contenido de frase
          // y adentro va un `<h2>`. `role="status"` es además el idioma de
          // región viva que usa toda la pantalla.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="status"
          className="space-y-1"
        >
          <h2 className="text-base font-medium text-ink">{CORTE.titulo}</h2>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">
            {hayHallazgos ? CORTE.textoConHallazgos : CORTE.texto}
          </p>
        </div>
        {action}
      </CardBody>
    </Card>
  )
}

export interface RunFailedNoticeProps {
  /**
   * Por qué se cortó, **ya traducido** (ver `traducirErrorTecnico`).
   *
   * `motivo.mensaje` va a la vista: suele ser lo único que le dice al usuario
   * qué tiene que arreglar de su lado para que la próxima corrida llegue hasta
   * el final. `motivo.detalle` —el texto crudo del motor— va plegado: no se
   * pierde, pero tampoco es lo primero que se lee. Antes acá se imprimía el
   * crudo, y podía ser un error de Postgres en inglés.
   */
  motivo?: ErrorLegible | null
  /** Volver a lanzar la revisión. Cuesta como una nueva, y se avisa antes. */
  action?: ReactNode
  className?: string
}

/**
 * La revisión se cortó.
 *
 * Va arriba de todo y no reemplaza a los hallazgos: lo que alcanzamos a
 * encontrar sigue siendo válido y se muestra igual. Cortarse no es lo mismo
 * que no haber encontrado nada.
 */
export function RunFailedNotice({ motivo, action, className }: RunFailedNoticeProps) {
  return (
    <Card tone="incompleto" emphasis="marked" className={className}>
      <CardBody className="space-y-4 pt-5 sm:pt-6">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-ink">{ESTADOS.jobFallado.titulo}</h2>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">
            {ESTADOS.jobFallado.texto}
          </p>
        </div>
        {motivo && (
          <div className="max-w-prose space-y-3">
            <p className="rounded-md border border-incompleto-border bg-incompleto-soft px-4 py-3 text-base leading-relaxed text-incompleto-text">
              {motivo.mensaje}
            </p>
            <TechnicalDetail detalle={motivo.detalle} />
          </div>
        )}
        {action}
      </CardBody>
    </Card>
  )
}

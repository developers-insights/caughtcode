import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardBody, Progress } from '@/components/ui'
import { ESTADOS } from '@/content/copy'
import { LISTA, PROGRESO } from './copy'
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
          <p role="status" className="text-sm text-incompleto-text">
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

export interface RunFailedNoticeProps {
  /**
   * Lo que reportó el motor al cortarse, tal cual.
   *
   * Va **a la vista** y no plegado detrás de un "detalle técnico": suele ser lo
   * único que le dice al usuario qué tiene que arreglar de su lado para que la
   * próxima corrida llegue hasta el final.
   */
  motivo?: string | null
  /** Retomar desde donde quedó. Sin volver a cobrar. */
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
          <p className="max-w-prose rounded-md border border-incompleto-border bg-incompleto-soft px-4 py-3 text-base leading-relaxed text-incompleto-text">
            {motivo}
          </p>
        )}
        {action}
      </CardBody>
    </Card>
  )
}

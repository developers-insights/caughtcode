'use client'

/**
 * Los tres estados que hay **antes** de tener resultados.
 *
 * Existen por la regla dura de "ninguna afirmación sin evidencia". Antes,
 * proyecto sin revisar, revisión esperando en la fila y revisión fallada
 * terminaban los tres en el mismo cartel: "no encontramos nada serio". A
 * alguien que no puede leer el código eso le suena a que su app está limpia, y
 * es lo contrario de lo que pasó.
 *
 * Por eso los tres se ven distinto sin necesidad de leer:
 * un problema que impide revisar no puede parecerse a una espera tranquila.
 */

import { useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Hourglass, RotateCcw, ScanSearch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Callout, Card, CardBody, EmptyState, ErrorState, motionPresets } from '@/components/ui'
import { startAuditAction } from '@/app/(app)/proyectos/nuevo/actions'
import { ANTES_DE_REVISAR, CORTE } from './copy'

/* ── Arrancar la revisión ──────────────────────────────────────────────── */

interface BotonRevisarProps {
  projectId: string
  children: string
  variant?: 'primary' | 'secondary'
  size?: 'md' | 'lg'
  icon: ReactNode
  /** Dónde va el mensaje si el servidor no pudo arrancar. */
  onError: (mensaje: string | null) => void
}

/**
 * Pone la revisión en la cola.
 *
 * Al volver no avisamos con un cartel flotante: pedimos la página de nuevo y
 * la propia pantalla pasa a "está en la fila". El cambio de estado es la
 * confirmación, y a diferencia de un aviso que se va solo, queda.
 */
function BotonRevisar({
  projectId,
  children,
  variant = 'primary',
  size = 'lg',
  icon,
  onError,
}: BotonRevisarProps) {
  const router = useRouter()
  const [enMarcha, arrancar] = useTransition()

  return (
    <Button
      variant={variant}
      size={size}
      icon={icon}
      loading={enMarcha}
      onClick={() => {
        onError(null)
        arrancar(async () => {
          const resultado = await startAuditAction({ projectId })
          if (!resultado.ok) {
            onError(resultado.error ?? null)
            return
          }
          router.refresh()
        })
      }}
    >
      {children}
    </Button>
  )
}

export interface ReviewRetryActionProps {
  projectId: string
  className?: string
}

/**
 * Volver a intentar, para cuando la revisión se cortó **pero** algo alcanzó a
 * encontrar. Ahí el aviso convive con la lista de hallazgos, así que la acción
 * va en segundo plano: lo importante de esa pantalla siguen siendo los
 * hallazgos que sí llegaron.
 */
export function ReviewRetryAction({ projectId, className }: ReviewRetryActionProps) {
  const [fallo, setFallo] = useState<string | null>(null)

  return (
    <div className={cn('space-y-3', className)}>
      <BotonRevisar
        projectId={projectId}
        variant="secondary"
        size="md"
        icon={<RotateCcw strokeWidth={1.9} />}
        onError={setFallo}
      >
        {ANTES_DE_REVISAR.fallada.accion}
      </BotonRevisar>
      {fallo && <Callout tone="expuesto">{fallo}</Callout>}
    </div>
  )
}

/* ── Nunca se revisó ───────────────────────────────────────────────────── */

export interface ReviewNotStartedProps {
  projectId: string
  className?: string
}

/**
 * Proyecto cargado, revisión nunca pedida.
 *
 * Es una invitación, no un error: fondo hundido, borde punteado y una sola
 * acción, que es lo único importante de la pantalla en este momento.
 */
export function ReviewNotStarted({ projectId, className }: ReviewNotStartedProps) {
  const [fallo, setFallo] = useState<string | null>(null)

  return (
    <motion.div
      variants={motionPresets.fadeUp}
      initial="hidden"
      animate="show"
      className={cn('space-y-4', className)}
    >
      <EmptyState
        icon={<ScanSearch aria-hidden="true" strokeWidth={1.7} />}
        title={ANTES_DE_REVISAR.sinRevisar.titulo}
        description={ANTES_DE_REVISAR.sinRevisar.texto}
        action={
          <BotonRevisar
            projectId={projectId}
            icon={<ScanSearch strokeWidth={1.9} />}
            onError={setFallo}
          >
            {ANTES_DE_REVISAR.sinRevisar.accion}
          </BotonRevisar>
        }
      />
      {fallo && <Callout tone="expuesto">{fallo}</Callout>}
    </motion.div>
  )
}

/* ── Esperando en la fila ──────────────────────────────────────────────── */

export interface ReviewQueuedProps {
  className?: string
}

/**
 * Pedida, todavía sin arrancar.
 *
 * Deliberadamente callado: sin color semántico, sin barra de progreso. Una
 * barra acá mentiría —no empezó nada— y el color está reservado para el estado
 * de un hallazgo.
 */
export function ReviewQueued({ className }: ReviewQueuedProps) {
  return (
    <motion.div variants={motionPresets.fadeUp} initial="hidden" animate="show">
      <Card className={className}>
        <CardBody className="flex items-start gap-4 pt-5 sm:pt-6">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-canvas-sunken text-ink-muted"
          >
            <Hourglass strokeWidth={1.7} className="size-5" />
          </span>
          <div role="status" className="space-y-1">
            <h2 className="text-base font-medium text-ink">{ANTES_DE_REVISAR.enCola.titulo}</h2>
            <p className="max-w-prose text-base leading-relaxed text-ink-muted">
              {ANTES_DE_REVISAR.enCola.texto}
            </p>
          </div>
        </CardBody>
      </Card>
    </motion.div>
  )
}

/* ── No se pudo revisar ────────────────────────────────────────────────── */

export interface ReviewFailedProps {
  projectId: string
  /** Lo que reportó el motor, tal cual. Sin esto el usuario no sabe qué pasó. */
  motivo: string | null
  className?: string
}

/**
 * La revisión no llegó a terminar.
 *
 * El motivo va **a la vista**, no escondido en un desplegable: casi siempre es
 * algo que solo el usuario puede resolver (un repositorio privado, una
 * dirección que no responde). Esconderlo lo deja sin saber qué hacer.
 */
export function ReviewFailed({ projectId, motivo, className }: ReviewFailedProps) {
  const [fallo, setFallo] = useState<string | null>(null)

  return (
    <div className={cn('space-y-4', className)}>
      <ErrorState
        kind="job-failed"
        title={ANTES_DE_REVISAR.fallada.titulo}
        description={
          <>
            {ANTES_DE_REVISAR.fallada.texto}
            {motivo && (
              <span className="mt-5 block rounded-md border border-expuesto-border bg-expuesto-soft px-4 py-3 text-left text-base leading-relaxed text-expuesto-text">
                {motivo}
              </span>
            )}
          </>
        }
        action={
          <BotonRevisar
            projectId={projectId}
            icon={<RotateCcw strokeWidth={1.9} />}
            onError={setFallo}
          >
            {ANTES_DE_REVISAR.fallada.accion}
          </BotonRevisar>
        }
      />
      {fallo && <Callout tone="expuesto">{fallo}</Callout>}
    </div>
  )
}

/* ── Corrida abandonada, sin nada guardado todavía ───────────────────────── */

export interface ReviewStalledProps {
  projectId: string
  className?: string
}

/**
 * La corrida dice "corriendo" pero dejó de latir, y no llegó a guardar nada
 * antes de cortarse.
 *
 * Se diferencia de `ReviewFailed` en el texto, no en la estructura: acá el
 * motor no reportó ningún motivo —se quedó callado a mitad de camino—, así
 * que no hay una caja de "esto fue lo que pasó" para mostrar. Decir que
 * "falló" sería afirmar algo que tampoco comprobamos; decimos exactamente lo
 * que sabemos, que es que se cortó.
 */
export function ReviewStalled({ projectId, className }: ReviewStalledProps) {
  const [fallo, setFallo] = useState<string | null>(null)

  return (
    <div className={cn('space-y-4', className)}>
      <ErrorState
        kind="job-failed"
        title={CORTE.titulo}
        description={CORTE.texto}
        action={
          <BotonRevisar
            projectId={projectId}
            icon={<RotateCcw strokeWidth={1.9} />}
            onError={setFallo}
          >
            {ANTES_DE_REVISAR.fallada.accion}
          </BotonRevisar>
        }
      />
      {fallo && <Callout tone="expuesto">{fallo}</Callout>}
    </div>
  )
}

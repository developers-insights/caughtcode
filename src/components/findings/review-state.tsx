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
import {
  Button,
  Callout,
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  motionPresets,
} from '@/components/ui'
import { startAuditAction } from '@/app/(app)/proyectos/nuevo/actions'
import { estimarRevisionAction } from '@/app/(app)/proyectos/[id]/hallazgos/actions'
import { traducirErrorTecnico, type ErrorLegible } from '@/content/lenguaje'
import { ANTES_DE_REVISAR, CONFIRMAR_REVISION, CORTE } from './copy'
import {
  dialogoAbierto,
  encolarSiSeConfirmoElPrecio,
  puedeEncolar,
  siguientePaso,
  type PasoDeConfirmacion,
} from './run-cost'
import { TechnicalDetail } from './technical-detail'

/* ── Arrancar la revisión ──────────────────────────────────────────────── */

interface BotonRevisarProps {
  projectId: string
  children: string
  variant?: 'primary' | 'secondary'
  size?: 'md' | 'lg'
  icon: ReactNode
  /** Nunca se revisó este proyecto. Cambia el título del cartel, nada más. */
  primeraVez?: boolean
  /** Ya hay hallazgos en pantalla: esta corrida los reemplaza, y hay que decirlo. */
  hayResultados?: boolean
  /** Dónde va el mensaje si el servidor no pudo arrancar. */
  onError: (mensaje: string | null) => void
}

/**
 * Pide la revisión — **después** de decir cuánto sale.
 *
 * Antes este botón encolaba la corrida en el mismo click, así que el usuario se
 * enteraba del precio cuando ya lo había gastado. Eso viola la regla dura #3
 * del producto y es, textualmente, la queja más repetida de la categoría.
 *
 * Ahora el click abre un cartel, el servidor saca la cuenta (los precios no
 * bajan al navegador) y recién con el número en pantalla se habilita confirmar.
 * Si la cuenta no sale, **no se encola igual**: preferimos hacer reintentar a
 * alguien antes que cobrarle sin avisarle.
 *
 * Al encolar no avisamos con un cartel flotante: pedimos la página de nuevo y
 * la propia pantalla pasa a "está en la fila". El cambio de estado es la
 * confirmación, y a diferencia de un aviso que se va solo, queda.
 */
function BotonRevisar({
  projectId,
  children,
  variant = 'primary',
  size = 'lg',
  icon,
  primeraVez = false,
  hayResultados = false,
  onError,
}: BotonRevisarProps) {
  const router = useRouter()
  const [paso, setPaso] = useState<PasoDeConfirmacion>({ paso: 'cerrado' })
  const [, arrancar] = useTransition()

  function abrir() {
    onError(null)
    setPaso(siguientePaso(paso, { tipo: 'abrir' }))

    void (async () => {
      const resultado = await estimarRevisionAction({ projectId })
      setPaso((actual) =>
        resultado.ok
          ? siguientePaso(actual, { tipo: 'presupuesto', presupuesto: resultado.presupuesto })
          : siguientePaso(actual, {
              tipo: 'sin-presupuesto',
              mensaje: resultado.error,
              detalle: resultado.detalle,
            }),
      )
    })()
  }

  function confirmar() {
    const actual = paso
    // Doble llave: el diálogo ya bloquea el botón sin precio, y acá se vuelve a
    // comprobar. La acción que cuesta plata no se llama desde ningún otro lado.
    if (!puedeEncolar(actual)) return

    setPaso(siguientePaso(actual, { tipo: 'confirmar' }))
    arrancar(async () => {
      const salida = await encolarSiSeConfirmoElPrecio(actual, () =>
        startAuditAction({ projectId }),
      )
      setPaso(salida.paso)
      if (salida.encolado) {
        router.refresh()
        return
      }
      onError(traducirErrorTecnico(salida.error)?.mensaje ?? CONFIRMAR_REVISION.noArranco)
    })
  }

  const textos = primeraVez ? CONFIRMAR_REVISION.primeraVez : CONFIRMAR_REVISION.otraVez

  return (
    <>
      <Button variant={variant} size={size} icon={icon} onClick={abrir}>
        {children}
      </Button>

      <ConfirmDialog
        open={dialogoAbierto(paso)}
        onOpenChange={() => setPaso(siguientePaso(paso, { tipo: 'cerrar' }))}
        title={textos.titulo}
        consequences={[
          ...CONFIRMAR_REVISION.consecuencias,
          ...(hayResultados ? [CONFIRMAR_REVISION.consecuenciaReemplazo] : []),
        ]}
        cost={
          paso.paso === 'listo' || paso.paso === 'encolando'
            ? {
                usd: paso.presupuesto.costUsd,
                units: paso.presupuesto.unidades.join(' · '),
                nota:
                  paso.presupuesto.medido && paso.presupuesto.archivos !== null
                    ? CONFIRMAR_REVISION.costo.medido(paso.presupuesto.archivos)
                    : CONFIRMAR_REVISION.costo.sinMedir,
              }
            : undefined
        }
        costPending={paso.paso === 'calculando' ? CONFIRMAR_REVISION.costo.calculando : undefined}
        costError={
          paso.paso === 'sin-presupuesto' ? (
            <>
              <p className="font-semibold">{CONFIRMAR_REVISION.falla.titulo}</p>
              <p>{paso.mensaje}</p>
              <p>{CONFIRMAR_REVISION.falla.texto}</p>
              <TechnicalDetail detalle={paso.detalle} className="pt-1" />
            </>
          ) : undefined
        }
        confirmLabel={textos.accion}
        cancelLabel={CONFIRMAR_REVISION.cancelar}
        loading={paso.paso === 'encolando'}
        onConfirm={confirmar}
      />
    </>
  )
}

/** Referencia estable: un JSX nuevo por render rompe la igualdad de props. */
const ICONO_REHACER = <RotateCcw aria-hidden="true" strokeWidth={1.8} className="size-4" />

export interface ReviewRunActionProps {
  projectId: string
  /** Rótulo del botón. Lo pone quien lo usa: no es lo mismo empezar que rehacer. */
  children: string
  variant?: 'primary' | 'secondary'
  size?: 'md' | 'lg'
  icon?: ReactNode
  primeraVez?: boolean
  hayResultados?: boolean
  className?: string
}

/**
 * El botón de revisar, para usar fuera de los estados de esta carpeta —hoy, el
 * encabezado de la pantalla de hallazgos.
 *
 * Existe porque ese encabezado tenía un `<Link>` a `/proyectos/[id]`, y esa
 * ruta redirige de vuelta a los hallazgos: el usuario lo apretaba y no pasaba
 * nada. Un control que no hace nada es peor que no tenerlo — sobre todo en una
 * app cuyo trabajo es marcarle ese defecto a los demás.
 */
export function ReviewRunAction({
  projectId,
  children,
  variant = 'secondary',
  size = 'md',
  icon = ICONO_REHACER,
  primeraVez = false,
  hayResultados = false,
  className,
}: ReviewRunActionProps) {
  const [fallo, setFallo] = useState<string | null>(null)

  return (
    <div className={cn('flex flex-col items-stretch gap-3 sm:items-end', className)}>
      <BotonRevisar
        projectId={projectId}
        variant={variant}
        size={size}
        icon={icon}
        primeraVez={primeraVez}
        hayResultados={hayResultados}
        onError={setFallo}
      >
        {children}
      </BotonRevisar>
      {/* El aviso va pegado al control que falló, no en un cartel flotante que
          se va solo: es algo que el usuario tiene que leer y volver a intentar.
          Acotado en ancho para no deformar el encabezado. */}
      {fallo && (
        <Callout tone="expuesto" className="max-w-sm text-left">
          {fallo}
        </Callout>
      )}
    </div>
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
        hayResultados
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
            primeraVez
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
          <div
            // `<output>` sería HTML inválido: solo admite contenido de frase y
            // adentro va un `<h2>`. `role="status"` es además el idioma de
            // región viva que usa toda la pantalla.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="status"
            className="space-y-1"
          >
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
  /**
   * Por qué se cortó, **ya traducido** (ver `traducirErrorTecnico`). El texto
   * crudo del motor viaja en `motivo.detalle` y va plegado: sin esto el usuario
   * no sabe qué pasó, pero con el original crudo tampoco.
   */
  motivo: ErrorLegible | null
  className?: string
}

/**
 * La revisión no llegó a terminar.
 *
 * El motivo va **a la vista**, no escondido en un desplegable: casi siempre es
 * algo que solo el usuario puede resolver (un repositorio privado, una
 * dirección que no responde). Esconderlo lo deja sin saber qué hacer. Lo que sí
 * va plegado es el texto original del motor, que no le dice nada a nadie que no
 * escriba código.
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
                {motivo.mensaje}
              </span>
            )}
          </>
        }
        detail={motivo?.detalle ?? undefined}
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

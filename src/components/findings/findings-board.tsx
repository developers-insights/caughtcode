'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleCheckBig } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState, buttonStyles, motionPresets } from '@/components/ui'
import { createClient } from '@/lib/supabase/client'
import { T } from '@/lib/db/tablas'
import { ESTADOS } from '@/content/copy'
import type { FindingRow, AnalysisRunRow } from '@/lib/types/database'
import type { Finding } from '@/lib/types/domain'
import { LISTA } from './copy'
import { FindingCard } from './finding-card'
import { aFinding, aRun } from './mappers'
import { PillarSection } from './pillar-section'
import {
  ReviewFailed,
  ReviewNotStarted,
  ReviewQueued,
  ReviewRetryAction,
  ReviewStalled,
} from './review-state'
import { RunFailedNotice, RunPartialNotice, RunProgress, RunStalledNotice } from './run-progress'
import {
  agruparPorPilar,
  estaCorriendo,
  estadoDeRevision,
  partirHallazgos,
  terminoAMedias,
  type FindingVideo,
  type JobView,
  type RunView,
} from './view'

/** Cada cuánto volvemos a preguntar si la revisión salió de la fila. */
const ESPERA_EN_COLA_MS = 10_000

/**
 * Cada cuánto refrescamos mientras la revisión corre.
 *
 * Los trabajos no viajan por Realtime (solo `analysis_runs` y `findings`, ver
 * `REALTIME` en `src/lib/db/tablas.ts`), así que el último latido que
 * conocemos acá queda congelado en el momento en que se armó la página. Sin
 * refrescar de a ratos, una corrida sana que lleva un rato larga terminaría
 * pareciendo abandonada solo porque no volvimos a preguntar — bastante menos
 * que `UMBRAL_SIN_LATIDO_MS` (4 min) para no llegar tarde a esa duda.
 */
const REVISAR_LATIDO_MS = 45_000

/**
 * Lo mismo, pero cuando ya la dimos por abandonada.
 *
 * Los 45 s existen para no llegar tarde a *descubrir* el abandono. Descubierto,
 * ese apuro no tiene sentido: seguir pidiendo la página entera cada 45 s, por
 * pestaña abierta y para siempre, es puro costo sobre una corrida que ya no se
 * mueve. Tampoco cortamos del todo — el servidor todavía puede rescatar el
 * trabajo por arriendo vencido y terminarla, y si eso pasa el usuario merece
 * enterarse sin recargar a mano.
 */
const REVISAR_ABANDONADA_MS = 5 * 60_000

export interface FindingsBoardProps {
  projectId: string
  /** Lo que ya estaba cuando se armó la página en el servidor. */
  findingsIniciales: Finding[]
  runInicial: RunView | null
  /**
   * Los trabajos encolados del proyecto. Es lo que permite distinguir
   * *todavía no revisamos* de *revisamos y no encontramos nada*: sin esto,
   * los dos casos se ven idénticos y le decimos a alguien que su app está
   * limpia sin haberla mirado nunca.
   */
  trabajos?: JobView[]
  /**
   * Qué hora era, para el servidor, cuando se leyeron esos trabajos.
   *
   * No usamos `Date.now()` del navegador: los latidos contra los que se compara
   * los escribe Postgres, y una máquina con el reloj adelantado más que
   * `UMBRAL_SIN_LATIDO_MS` daría por muerta una revisión perfectamente sana.
   * Además, con el reloj cerca del borde, el servidor y la hidratación podrían
   * sacar conclusiones distintas de los mismos datos; con un valor que viaja en
   * la carga, las dos pasadas calculan lo mismo.
   *
   * Que quede congelado entre refrescos es la intención, no un defecto: la fase
   * cambia cuando el servidor manda datos nuevos, no cuando corre el reloj del
   * usuario. Lo que la mantiene fresca es `REVISAR_LATIDO_MS`.
   */
  ahoraServidorMs: number
  /** Estado del video de cada hallazgo destacado, por id de hallazgo. */
  videos?: Record<string, FindingVideo>
  /**
   * Escuchar la base en vivo. Se apaga en la demostración, donde no hay
   * base a la que suscribirse.
   */
  live?: boolean
  className?: string
}

/**
 * La lista de hallazgos.
 *
 * Es un componente de cliente por una sola razón: mientras la revisión corre,
 * los hallazgos tienen que aparecer solos, sin recargar y sin que el usuario
 * se quede mirando una barra. Todo lo demás que hay acá adentro se podría
 * renderizar en el servidor y se comporta igual.
 */
export function FindingsBoard({
  projectId,
  findingsIniciales,
  runInicial,
  trabajos = [],
  ahoraServidorMs,
  videos,
  live = true,
  className,
}: FindingsBoardProps) {
  const router = useRouter()
  const [findings, setFindings] = useState<Finding[]>(findingsIniciales)
  const [run, setRun] = useState<RunView | null>(runInicial)
  const [desconectado, setDesconectado] = useState(false)

  // El servidor manda la verdad cuando la página se vuelve a armar.
  useEffect(() => setFindings(findingsIniciales), [findingsIniciales])
  useEffect(() => setRun(runInicial), [runInicial])

  const corriendo = estaCorriendo(run)
  const estado = useMemo(
    () => estadoDeRevision(run, trabajos, ahoraServidorMs),
    [run, trabajos, ahoraServidorMs],
  )

  /* ── En vivo ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!live || !run?.id || !corriendo) return

    const supabase = createClient()
    const runId = run.id

    const canal = supabase
      .channel(`hallazgos:${runId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: T.findings,
          filter: `analysis_run_id=eq.${runId}`,
        },
        (payload) => {
          const row = payload.new as FindingRow | null
          if (!row?.id) return
          const entrante = aFinding(row)
          setFindings((previos) => {
            const i = previos.findIndex((f) => f.id === entrante.id)
            if (i === -1) return [...previos, entrante]
            const copia = [...previos]
            copia[i] = entrante
            return copia
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: T.analysisRuns, filter: `id=eq.${runId}` },
        (payload) => {
          const row = payload.new as AnalysisRunRow | null
          if (!row?.id) return
          const actualizada = aRun(row)
          setRun(actualizada)
          // Al terminar pedimos la página de nuevo: así entran los videos y
          // cualquier cosa que el servidor sepa y el evento no traiga.
          if (!estaCorriendo(actualizada)) router.refresh()
        },
      )
      .subscribe((estado) => {
        setDesconectado(estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT')
      })

    return () => {
      void supabase.removeChannel(canal)
    }
  }, [live, run?.id, corriendo, router])

  /**
   * Mientras espera en la fila no hay a qué suscribirse: la corrida todavía no
   * existe. Preguntamos de a ratos para que la pantalla cambie sola cuando
   * arranque, en vez de quedarse pidiendo que recargues.
   */
  useEffect(() => {
    if (!live || estado.fase !== 'en-cola') return
    const reloj = setInterval(() => router.refresh(), ESPERA_EN_COLA_MS)
    return () => clearInterval(reloj)
  }, [live, estado.fase, router])

  /**
   * Mientras corre, refrescamos de a ratos para mantener fresco el último
   * latido que conocemos (ver `REVISAR_LATIDO_MS`). Es lo que permite que la
   * pantalla note sola cuando una corrida se quedó sin nadie del otro lado,
   * sin que haga falta recargar.
   *
   * El ritmo lo marca la fase, no `estaCorriendo(run)`: una corrida trabada en
   * "corriendo" que ya dimos por abandonada seguiría pidiendo la página entera
   * cada 45 s para siempre, y no hay nada que esperar con esa urgencia.
   */
  useEffect(() => {
    if (!live) return

    const cada =
      estado.fase === 'corriendo'
        ? REVISAR_LATIDO_MS
        : estado.fase === 'abandonada'
          ? REVISAR_ABANDONADA_MS
          : null
    if (cada === null) return

    const reloj = setInterval(() => router.refresh(), cada)
    return () => clearInterval(reloj)
  }, [live, estado.fase, router])

  /* ── Reparto ─────────────────────────────────────────────────────────── */

  const { destacados, resto, cerrados } = useMemo(() => partirHallazgos(findings), [findings])
  const grupos = useMemo(() => agruparPorPilar(resto), [resto])
  const gruposCerrados = useMemo(() => agruparPorPilar(cerrados), [cerrados])

  const hrefDe = (f: Finding) => `/proyectos/${projectId}/hallazgos/${f.id}`
  const vacio = findings.length === 0

  /* ── Antes de que haya algo que mostrar ──────────────────────────────── */

  // Estos tres reemplazan a la lista entera, no la acompañan: no hay nada que
  // listar todavía. Van primero justamente para que no puedan terminar en el
  // cartel de "no encontramos nada serio", que es una afirmación sobre algo
  // que en estos casos nunca se miró.
  if (estado.fase === 'sin-revisar') {
    return <ReviewNotStarted projectId={projectId} className={className} />
  }

  if (estado.fase === 'en-cola') {
    return <ReviewQueued className={className} />
  }

  if (estado.fase === 'fallada' && vacio) {
    return <ReviewFailed projectId={projectId} motivo={estado.motivo} className={className} />
  }

  // Misma idea que la anterior, pero acá no hay `motivo`: el motor no avisó
  // nada, se quedó callado. Ver `corridaAbandonada` en `view.ts`.
  if (estado.fase === 'abandonada' && vacio) {
    return <ReviewStalled projectId={projectId} className={className} />
  }

  return (
    <div className={cn('space-y-12', className)}>
      {estado.fase === 'corriendo' && (
        <RunProgress run={estado.run} encontrados={findings.length} desconectado={desconectado} />
      )}

      {/* La corrida dice "corriendo" pero ya no hay nadie del otro lado. Va en
          el mismo lugar que la barra que reemplaza, y no tapa lo que ya se
          encontró: eso sigue abajo, intacto. */}
      {estado.fase === 'abandonada' && (
        <RunStalledNotice
          hayHallazgos={!vacio}
          action={<ReviewRetryAction projectId={projectId} />}
        />
      )}

      {terminoAMedias(run) && <RunPartialNotice />}

      {/* Se cortó, pero algo alcanzó a encontrar. El aviso va arriba y no
          reemplaza a la lista: lo que llegó sigue siendo válido. */}
      {estado.fase === 'fallada' && (
        <RunFailedNotice
          motivo={estado.motivo}
          action={<ReviewRetryAction projectId={projectId} />}
        />
      )}

      {/* El único lugar donde corresponde decir que no encontramos nada: una
          revisión que terminó entera. */}
      {vacio && estado.fase === 'lista' && estado.run.status === 'succeeded' && (
        <EmptyState
          icon={<CircleCheckBig aria-hidden="true" strokeWidth={1.7} className="size-7" />}
          title={ESTADOS.vacioHallazgos.titulo}
          description={ESTADOS.vacioHallazgos.texto}
          action={
            <Link
              href={`/proyectos/${projectId}/hallazgos/cobertura`}
              className={buttonStyles({ variant: 'secondary' })}
            >
              {ESTADOS.vacioHallazgos.accion}
            </Link>
          }
        />
      )}

      {destacados.length > 0 && (
        <section aria-labelledby="destacados">
          <Encabezado
            id="destacados"
            titulo={LISTA.destacados.encabezado}
            ayuda={LISTA.destacados.ayuda}
            destacado
          />

          <motion.ul
            variants={motionPresets.listContainer}
            initial="hidden"
            animate="show"
            className="flex flex-col gap-5"
          >
            <AnimatePresence initial={false}>
              {destacados.map((finding, i) => (
                <motion.li
                  key={finding.id}
                  variants={motionPresets.listItem}
                  initial="hidden"
                  animate="show"
                  exit="gone"
                >
                  <FindingCard
                    finding={finding}
                    href={hrefDe(finding)}
                    video={videos?.[finding.id]}
                    variante="destacado"
                    posicion={i + 1}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        </section>
      )}

      {grupos.length > 0 && (
        <section aria-labelledby="resto">
          <Encabezado id="resto" titulo={LISTA.resto.encabezado} ayuda={LISTA.resto.ayuda} />
          <div className="flex flex-col gap-3">
            {grupos.map((grupo) => (
              <PillarSection
                key={grupo.pilar}
                titulo={grupo.titulo}
                hallazgos={grupo.hallazgos}
                hrefDe={hrefDe}
              />
            ))}
          </div>
        </section>
      )}

      {gruposCerrados.length > 0 && (
        <section aria-labelledby="cerrados">
          <Encabezado
            id="cerrados"
            titulo={LISTA.cerrados.encabezado}
            ayuda={LISTA.cerrados.ayuda}
          />
          <div className="flex flex-col gap-3">
            {gruposCerrados.map((grupo) => (
              <PillarSection
                key={grupo.pilar}
                titulo={grupo.titulo}
                hallazgos={grupo.hallazgos}
                hrefDe={hrefDe}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function Encabezado({
  id,
  titulo,
  ayuda,
  destacado = false,
}: {
  id: string
  titulo: string
  ayuda: string
  destacado?: boolean
}) {
  return (
    <div className="mb-4">
      <h2
        id={id}
        className={cn(
          'text-ink',
          destacado ? 'font-display text-2xl leading-tight' : 'text-base font-medium',
        )}
      >
        {titulo}
      </h2>
      <p className={cn('mt-1 text-ink-muted', destacado ? 'text-base' : 'text-sm')}>{ayuda}</p>
    </div>
  )
}

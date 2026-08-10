/**
 * Quién decide que una auditoría terminó, y cómo terminó.
 *
 * ## Por qué existe este archivo
 *
 * Antes nadie cerraba una corrida bien terminada. El único que escribía
 * `analysis_runs.status` era el camino de falla de `ingest_repo`, y
 * `publishRunProgress` —lo que usan los latidos— toca solo `stage` y
 * `progress`, nunca `status` ni `error`. Resultado real en producción: la
 * cadena entera en `succeeded`, 180 hallazgos guardados, y la corrida
 * congelada en `failed` con el mensaje de un primer intento de una hora antes.
 * La pantalla de hallazgos lee ese estado, así que le tapaba al usuario 180
 * hallazgos que sí teníamos.
 *
 * ## La regla
 *
 * El estado de la corrida no se declara: **se deduce de los trabajos que la
 * componen**, que es lo único que de verdad pasó. Mientras quede uno pendiente,
 * la corrida no se cierra. Cuando no queda ninguno:
 *
 *   - ninguno falló                → `succeeded` (y se borra el error viejo)
 *   - algo falló pero hay hallazgos → `partial`  (lo encontrado sigue valiendo)
 *   - algo falló y no hay nada      → `failed`
 *
 * Es la misma regla dura de siempre: ninguna afirmación sin evidencia, ni para
 * decir que falló ni para decir que salió bien.
 */

import type { JobKind, JobStatus, RunStatus } from '@/lib/types/domain'
import { T } from '@/lib/db/tablas'
import { describeDbError, jobsDb } from './db'
import { markRunFinished } from './progress'

/**
 * Los trabajos que componen una revisión.
 *
 * `scan_comments` y `build_tutorials` alimentan otras pantallas: que uno de
 * esos se caiga no dice nada sobre la revisión y no puede teñirla.
 *
 * Espejo de `TRABAJOS_DE_REVISION` en `src/components/findings/view.ts`, que
 * aplica el mismo criterio del lado de la pantalla. Las dos listas tienen que
 * decir lo mismo; el lugar natural para unificarlas es `@/lib/types/domain`.
 */
export const TRABAJOS_DE_REVISION: readonly JobKind[] = [
  'ingest_repo',
  'index_code',
  'run_checks',
  'run_browser_agent',
  'generate_video',
]

export function esTrabajoDeRevision(kind: JobKind): boolean {
  return TRABAJOS_DE_REVISION.includes(kind)
}

/** Trabajos que todavía pueden cambiar de resultado. */
const PENDIENTES: readonly JobStatus[] = ['queued', 'running']

/** Texto que ve el usuario cuando la revisión terminó bien. Sin jerga. */
export const ETAPA_TERMINADA = 'Terminamos de revisar tu proyecto'

export interface ResultadoReconciliacion {
  /** Estado en el que quedó la corrida. `null` = no se tocó. */
  status: RunStatus | null
  /** Trabajos de la revisión que siguen en cola o corriendo. */
  pendientes: number
  /** Trabajos de la revisión que terminaron mal. */
  fallados: number
  /** Si hay hallazgos guardados: es lo que separa `partial` de `failed`. */
  hayHallazgos: boolean
}

const SIN_CAMBIOS: ResultadoReconciliacion = {
  status: null,
  pendientes: 0,
  fallados: 0,
  hayHallazgos: false,
}

/**
 * Mira todos los trabajos de la corrida y, si ya no queda nada por hacer, la
 * cierra con el estado que corresponde. Idempotente: llamarla de más no rompe
 * nada, solo vuelve a escribir el mismo estado.
 */
export async function reconcileRunStatus(
  analysisRunId: string | null | undefined,
): Promise<ResultadoReconciliacion> {
  if (!analysisRunId) return SIN_CAMBIOS

  const db = await jobsDb()
  const { data, error } = await db
    .from(T.jobs)
    .select('id, kind, status, last_error')
    .eq('analysis_run_id', analysisRunId)

  if (error) {
    throw new Error(`No se pudo revisar en qué quedó la auditoría: ${describeDbError(error)}`)
  }

  const trabajos = (data ?? []).filter((fila: Record<string, any>) =>
    esTrabajoDeRevision(fila.kind as JobKind),
  ) as Array<Record<string, any>>

  // Sin trabajos propios no hay nada de qué deducir. Inventar un estado acá
  // sería exactamente el error que este archivo viene a arreglar.
  if (trabajos.length === 0) return SIN_CAMBIOS

  const pendientes = trabajos.filter((t) => PENDIENTES.includes(t.status as JobStatus))
  if (pendientes.length > 0) {
    return { status: null, pendientes: pendientes.length, fallados: 0, hayHallazgos: false }
  }

  const fallados = trabajos.filter((t) => t.status === 'failed' || t.status === 'cancelled')
  const hayHallazgos = fallados.length > 0 ? await tieneHallazgos(db, analysisRunId) : false

  const status: RunStatus =
    fallados.length === 0 ? 'succeeded' : hayHallazgos ? 'partial' : 'failed'

  await markRunFinished(analysisRunId, {
    status,
    // En `succeeded` el `null` es el que borra el error de un intento anterior:
    // un error que sobrevive a un intento que salió bien es una mentira.
    error: status === 'succeeded' ? null : primerMotivo(fallados),
    // El `stage` de una corrida terminada bien es el final; en las otras se
    // deja el último que se publicó, que dice dónde se cortó.
    ...(status === 'succeeded' ? { stage: ETAPA_TERMINADA } : {}),
  })

  return { status, pendientes: 0, fallados: fallados.length, hayHallazgos }
}

/** ¿Quedó algo utilizable? Alcanza con saber si hay al menos uno. */
async function tieneHallazgos(
  db: Awaited<ReturnType<typeof jobsDb>>,
  analysisRunId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from(T.findings)
    .select('id')
    .eq('analysis_run_id', analysisRunId)
    .limit(1)

  if (error) {
    throw new Error(`No se pudo comprobar si quedaron hallazgos: ${describeDbError(error)}`)
  }
  return Array.isArray(data) ? data.length > 0 : Boolean(data)
}

/** El motivo que se le muestra al usuario: el primero que dejó un mensaje. */
function primerMotivo(fallados: Array<Record<string, any>>): string | null {
  for (const trabajo of fallados) {
    const motivo = typeof trabajo.last_error === 'string' ? trabajo.last_error.trim() : ''
    if (motivo) return motivo
  }
  return null
}

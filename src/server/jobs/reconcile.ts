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
import { describeError } from './errors'
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
    // `project_id` viaja para poder borrar el código del disco al cerrar: la
    // carpeta es `<raíz>/<projectId>/<runId>/`, y la corrida sola no alcanza.
    .select('id, kind, status, last_error, project_id')
    .eq('analysis_run_id', analysisRunId)

  if (error) {
    throw new Error(`No se pudo revisar en qué quedó la auditoría: ${describeDbError(error)}`)
  }

  const todos = (data ?? []) as Array<Record<string, any>>
  const trabajos = todos.filter((fila) => esTrabajoDeRevision(fila.kind as JobKind))

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

  await borrarCodigoDeLaCorrida(analysisRunId, todos)

  return { status, pendientes: 0, fallados: fallados.length, hayHallazgos }
}

/* ── El código del usuario se va del disco cuando la corrida cierra ──────── */

/**
 * Borra `<CAUGHTCODE_STORAGE_DIR>/<projectId>/<runId>/` al cerrar la corrida.
 *
 * ## Por qué acá
 *
 * `withWorkspace()` y `removeWorkspace()` no tenían un solo llamador en la
 * cadena de trabajos: el único que los usaba era el onboarding. En Vercel no se
 * notaba porque `/tmp` muere con la invocación. Con el trabajo mudándose a un
 * Background Worker de Render, que vive días, el código de todos los inquilinos
 * se acumularía en disco indefinidamente — y `retentionSummary()` le promete al
 * usuario que su código se borra apenas termina el análisis. Esta es la única
 * llamada del pipeline que corre exactamente una vez por corrida terminada, sin
 * importar por qué camino terminó.
 *
 * ## Los tres cuidados
 *
 * 1. **No borrar código en uso.** Se exige que no quede NINGÚN trabajo de la
 *    corrida pendiente, de cualquier tipo — no solo los de revisión. Un
 *    `scan_comments` encolado también lee `payload.repoPath`, y la corrida
 *    puede cerrar en `partial` con él todavía en vuelo.
 * 2. **No romper la reconciliación.** El estado de la corrida ya está escrito y
 *    es lo que la persona necesita ver. Si el borrado falla, se registra y se
 *    sigue; `purgeExpired()` y la retención por días quedan como red de atrás.
 * 3. **Idempotente.** `rm(..., { force: true })` sobre una carpeta que ya no
 *    está no hace nada y no tira. Y si un reintento posterior vuelve a
 *    necesitar el código, `rehidratar()` lo baja del bucket `repos_caughtcode`,
 *    que es la copia que sí sobrevive.
 *
 * El import es tardío a propósito: `workspace.ts` arranca con
 * `import 'server-only'` y trae `node:fs`. Cargándolo recién cuando de verdad se
 * va a borrar, este módulo sigue siendo importable desde cualquier lado.
 */
async function borrarCodigoDeLaCorrida(
  analysisRunId: string,
  todos: Array<Record<string, any>>,
): Promise<void> {
  const enVuelo = todos.filter((fila) => PENDIENTES.includes(fila.status as JobStatus))
  if (enVuelo.length > 0) return

  const projectId = todos
    .map((fila) => fila.project_id)
    .find((id: unknown): id is string => typeof id === 'string' && id.length > 0)
  if (!projectId) return

  try {
    const { removeWorkspace } = await import('@/server/ingest/workspace')
    await removeWorkspace(projectId, analysisRunId)
  } catch (error) {
    console.error(
      `[jobs] no se pudo borrar del disco el código de la corrida ${analysisRunId}: ` +
        `${describeError(error)}`,
    )
  }
}

/* ── Red de seguridad: corridas que quedaron abiertas sin nadie trabajando ── */

export interface ResultadoBarrida {
  /** Corridas `running` que se miraron. */
  revisadas: number
  /** De esas, cuántas se cerraron porque ya no tenían nada pendiente. */
  cerradas: number
}

/**
 * Cuántas corridas abiertas se miran por pasada. El tick corre cada minuto: no
 * hace falta barrer el universo de una, y un tope evita que una base con mucha
 * basura vieja se coma el tiempo de la tanda.
 */
const MAX_CORRIDAS_POR_BARRIDA = 100

/**
 * Cierra las corridas que quedaron `running` sin un solo trabajo de revisión en
 * cola ni corriendo.
 *
 * ## Por qué hace falta además de reconciliar en cada final
 *
 * Hoy una corrida se cierra únicamente cuando alguno de sus trabajos TERMINA y
 * dispara `reconcileRunStatus()`. Si el último trabajo desaparece sin terminar
 * —la instancia se murió por OOM y el rescate lo marcó `failed`, o se lo canceló
 * a mano en la base— no queda nadie que dispare el cierre y la corrida se queda
 * abierta para siempre. Con la reconciliación de `requeueExpired()` eso ya no
 * debería pasar, pero "no debería" no es una garantía: esta barrida es la que la
 * da, sin depender de que ningún camino en particular se acuerde de llamar.
 *
 * ## Por qué acá y no en SQL
 *
 * La regla de con qué estado cierra una corrida (`succeeded` / `partial` /
 * `failed`, y qué error se le muestra al usuario) vive en `reconcileRunStatus()`
 * y en ningún otro lado. Escribirla también en la migración sería tener la misma
 * decisión en dos idiomas, que es exactamente la clase de bug que este archivo
 * vino a arreglar. Acá solo se buscan candidatas; quien decide sigue siendo uno.
 *
 * Cuesta dos consultas fijas, no una por corrida: una trae las corridas abiertas
 * y otra los trabajos de revisión pendientes de todas ellas juntas.
 */
export async function barrerCorridasHuerfanas(
  limite: number = MAX_CORRIDAS_POR_BARRIDA,
): Promise<ResultadoBarrida> {
  const db = await jobsDb()

  const { data: abiertas, error: errorCorridas } = await db
    .from(T.analysisRuns)
    .select('id')
    .eq('status', 'running')
    // Sin `order`, PostgREST no garantiza QUÉ filas devuelve el `limit`: con más
    // de MAX_CORRIDAS_POR_BARRIDA corridas abiertas acumuladas —justo el estado
    // del que hay que salir— la barrida podía traer siempre el mismo subconjunto
    // y no llegar nunca a las demás. Las más viejas primero: son las que llevan
    // más tiempo con el spinner girando.
    .order('started_at', { ascending: true })
    .limit(Math.max(1, limite))

  if (errorCorridas) {
    throw new Error(
      `No se pudieron listar las auditorías abiertas: ${describeDbError(errorCorridas)}`,
    )
  }

  const ids = (abiertas ?? [])
    .map((fila: Record<string, any>) => String(fila.id))
    .filter((id: string) => id.length > 0)
  if (ids.length === 0) return { revisadas: 0, cerradas: 0 }

  const { data: pendientes, error: errorTrabajos } = await db
    .from(T.jobs)
    .select('analysis_run_id')
    .in('analysis_run_id', ids)
    .in('status', [...PENDIENTES])
    .in('kind', [...TRABAJOS_DE_REVISION])

  if (errorTrabajos) {
    throw new Error(
      `No se pudo saber qué auditorías siguen trabajando: ${describeDbError(errorTrabajos)}`,
    )
  }

  const ocupadas = new Set(
    (pendientes ?? [])
      .map((fila: Record<string, any>) => fila.analysis_run_id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
  )

  let cerradas = 0
  for (const id of ids) {
    if (ocupadas.has(id)) continue
    // `reconcileRunStatus` se planta si la corrida no tiene trabajos propios:
    // sin evidencia no inventa un estado, y una corrida recién creada a la que
    // todavía no se le encoló nada tiene que seguir abierta.
    const { status } = await reconcileRunStatus(id)
    if (status) cerradas += 1
  }

  return { revisadas: ids.length, cerradas }
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

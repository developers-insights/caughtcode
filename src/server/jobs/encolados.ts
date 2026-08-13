/**
 * Vencimiento de trabajos que quedaron encolados y **nadie atiende**.
 *
 * ## El agujero que tapa
 *
 * `requeue_expired_jobs_caughtcode()` solo mira `status = 'running'`: rescata al
 * trabajo cuyo worker se murió con él en la mano. Un trabajo que nunca llegó a
 * ser tomado no está `running`, está `queued`, y nadie lo envejecía nunca.
 *
 * Eso dejó de ser teórico cuando el tick de Vercel dejó de pedir
 * `run_browser_agent`, `generate_video` y `build_tutorials` (no hay navegador en
 * la función serverless; ver `KINDS_EN_SERVERLESS` en la ruta del tick). Un
 * proyecto con `deployedUrl` hace que `index_code` encole `run_browser_agent`.
 * Si el worker de Render todavía no existe, está reiniciando o se cayó, ese
 * trabajo se queda `queued` para siempre → `barrerCorridasHuerfanas()` lo cuenta
 * como pendiente → la corrida nunca cierra → la pantalla gira eternamente, sin
 * un solo log. Es el mismo bug de siempre entrando por otra puerta.
 *
 * Desde que `index_code` deja además una revisión diferida de red
 * (`DIFERIMIENTO_RED_MS`), esa corrida sí llega a tener hallazgos aunque el
 * agente nunca corra. Pero seguiría sin **cerrar**: el `run_browser_agent`
 * encolado la mantiene abierta hasta que algo lo dé por perdido, y ese algo es
 * esto. Los dos mecanismos son necesarios y hacen cosas distintas: uno salva el
 * resultado, el otro cierra la corrida.
 *
 * ## La regla, y por qué NO es "un encolado viejo está muerto"
 *
 * Un trabajo que espera puede estar esperando por dos motivos muy distintos:
 *
 *   a) **hay quien lo atienda y está ocupado** → hay que dejarlo en paz;
 *   b) **no hay quien lo atienda** → hay que darlo por perdido y avisarle al
 *      usuario, porque si no la corrida no cierra nunca.
 *
 * Distinguirlos no se puede desde adentro de un proceso —el tick de Vercel no
 * sabe si existe un worker de Render—, pero **sí se puede desde la tabla**: si
 * alguien atiende un tipo de trabajo, deja rastro. Un trabajo de ese tipo pasa
 * por `running` (el latido le toca `updated_at` cada 15 s), o termina en
 * `succeeded`/`failed`. Entonces:
 *
 *   > Un `queued` se da por muerto solo si hace más de `ESPERA_MAXIMA_EN_COLA_MS`
 *   > que podría haber corrido Y en esa misma ventana **ningún** trabajo de su
 *   > mismo `kind` se movió de `queued`.
 *
 * Las dos condiciones importan:
 *
 * - Se mide sobre `run_after`, no sobre `created_at`. `run_after` es justamente
 *   el campo donde viven los reintentos con backoff y las verificaciones
 *   agendadas a futuro: un trabajo programado para dentro de dos horas tiene
 *   `run_after` en el futuro y no es candidato ni por asomo.
 * - La evidencia de atención se busca solo en estados que **prueban que un
 *   worker lo tocó** (`running`, `succeeded`, `failed`, `cancelled`). Un
 *   `queued` no prueba nada: contarlo dejaría que un trabajo se blindara a sí
 *   mismo con su propio `updated_at`.
 *
 * ## De dónde sale el umbral (30 minutos)
 *
 * Números reales de este sistema, no un redondeo lindo:
 *
 * - **Camino serverless.** El cron dispara cada 60 s, el tick toma
 *   `DEFAULT_MAX_JOBS = 1` trabajo, y el candado dura
 *   `LOCK_TTL_SECONDS = maxDuration + 30 = 330 s`. En el peor caso imaginable
 *   —cada tick usando la invocación entera— el piso de rendimiento es **un
 *   trabajo cada 5,5 minutos**. 30 minutos son 5 o 6 trabajos de otros tipos
 *   drenados delante del nuestro, con el peor tick posible en cada uno.
 * - **Worker de Render.** `WORKER_CONCURRENCY = 2` y `WORKER_POLL_MS = 2000`:
 *   toma el encolado más viejo a los 2 s de tener lugar. Para que un trabajo
 *   espere 30 minutos, sus dos slots tienen que estar ocupados media hora
 *   seguida con trabajos de otros tipos y sin cerrar ni uno del tipo nuestro.
 * - **Un worker que se muere no blinda nada.** `DEFAULT_LEASE_SECONDS = 90` y
 *   `requeueExpired()` corre cada 60 s (`WORKER_REQUEUE_MS`) y además en cada
 *   tick: un `running` fantasma vuelve a `queued` en ≤ 150 s, doce veces menos
 *   que la ventana. La evidencia de atención se apaga sola.
 * - **Una corrida no se autoexpira por congestión propia.** Su cadena completa
 *   son como mucho 7 trabajos (`ingest_repo`, `index_code`,
 *   `run_browser_agent`, `run_checks` y hasta 3 videos, por
 *   `MAX_VIDEOS_POR_CORRIDA = 3`).
 *
 * O sea: para un falso positivo hace falta un estado ya patológico. Y el costo
 * de equivocarse es acotado y reversible —la persona vuelve a pedir la
 * revisión—, mientras que el costo de no hacer nada es un spinner infinito.
 */

import type { JobKind, JobStatus } from '@/lib/types/domain'
import { T } from '@/lib/db/tablas'
import { describeDbError, jobsDb, type JobsDb } from './db'
import { describeError } from './errors'
import { reconcileRunStatus } from './reconcile'
import { JOB_KIND_LABEL } from './registry'

/** Cuánto puede esperar un encolado sin que nadie de su tipo dé señales de vida. */
export const ESPERA_MAXIMA_EN_COLA_MS = 30 * 60_000

/** Tope de candidatos por pasada, para que una cola sucia no se coma la tanda. */
const MAX_POR_BARRIDA = 200

/**
 * Estados que prueban que un worker tocó ese tipo de trabajo. `queued` queda
 * afuera a propósito: es el estado de los candidatos, y contarlo los blindaría.
 */
const ESTADOS_QUE_PRUEBAN_ATENCION: readonly JobStatus[] = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
]

export interface ResultadoVencimiento {
  /** Encolados que pasaron el umbral de espera y se miraron. */
  revisados: number
  /** De esos, cuántos se dieron por perdidos. */
  vencidos: number
  /** Tipos con señales de vida en la ventana: sus encolados no se tocaron. */
  atendidos: JobKind[]
}

export interface OpcionesVencimiento {
  /** Ventana de espera en ms. Por defecto `ESPERA_MAXIMA_EN_COLA_MS`. */
  espera?: number
  limite?: number
  now?: Date
}

const SIN_VENCIDOS: ResultadoVencimiento = { revisados: 0, vencidos: 0, atendidos: [] }

/**
 * Marca `failed` los encolados que nadie atiende y cierra las corridas que
 * quedaron destrabadas.
 *
 * Idempotente: solo toca filas que siguen en `queued`, y las deja en `failed`.
 * Una segunda pasada no encuentra nada.
 */
export async function vencerEncoladosDesatendidos(
  options: OpcionesVencimiento = {},
): Promise<ResultadoVencimiento> {
  // Piso de un minuto: una ventana de cero convertiría esto en "matá todo lo
  // que esté encolado", que es exactamente lo contrario de lo que hace falta.
  const espera = Math.max(60_000, Math.round(options.espera ?? ESPERA_MAXIMA_EN_COLA_MS))
  const ahora = options.now ?? new Date()
  const corte = new Date(ahora.getTime() - espera).toISOString()

  const db = await jobsDb()

  const { data, error } = await db
    .from(T.jobs)
    .select('id, kind, analysis_run_id, run_after')
    .eq('status', 'queued')
    // `run_after` y no `created_at`: acá viven el backoff y lo agendado a futuro.
    .lt('run_after', corte)
    // Sin `order` PostgREST no garantiza qué filas trae con `limit`: con la cola
    // sucia se podría barrer siempre el mismo subconjunto. Los más viejos primero.
    .order('run_after', { ascending: true })
    .limit(Math.max(1, options.limite ?? MAX_POR_BARRIDA))

  if (error) {
    throw new Error(`No se pudo revisar la cola de trabajos en espera: ${describeDbError(error)}`)
  }

  const candidatos = (data ?? []) as Array<Record<string, any>>
  if (candidatos.length === 0) return SIN_VENCIDOS

  const kinds = [...new Set(candidatos.map((fila) => String(fila.kind)))] as JobKind[]
  const atendidos = await tiposConAtencionReciente(db, kinds, corte)

  let vencidos = 0
  const corridas = new Set<string>()

  for (const fila of candidatos) {
    const kind = fila.kind as JobKind
    if (atendidos.has(kind)) continue

    const marcado = await darPorPerdido(db, String(fila.id), kind, espera)
    if (!marcado) continue

    vencidos += 1
    const runId = fila.analysis_run_id
    if (typeof runId === 'string' && runId.length > 0) corridas.add(runId)
  }

  // Cerrar la corrida es el punto de todo esto, pero no puede tirar abajo la
  // barrida: el trabajo ya quedó `failed`, que es lo que destraba, y la corrida
  // se reconcilia igual en la próxima pasada o desde `barrerCorridasHuerfanas()`.
  for (const analysisRunId of corridas) {
    try {
      await reconcileRunStatus(analysisRunId)
    } catch (error) {
      console.error(
        `[jobs] no se pudo cerrar la corrida ${analysisRunId} después de dar por perdidos sus ` +
          `trabajos encolados: ${describeError(error)}`,
      )
    }
  }

  return { revisados: candidatos.length, vencidos, atendidos: [...atendidos] }
}

/**
 * ¿Alguien atendió alguno de estos tipos desde `desde`?
 *
 * Una sola consulta para todos los tipos juntos. Alcanza con saber qué tipos
 * aparecen: no importa cuántas filas ni de quién sean.
 */
async function tiposConAtencionReciente(
  db: JobsDb,
  kinds: JobKind[],
  desde: string,
): Promise<Set<JobKind>> {
  const { data, error } = await db
    .from(T.jobs)
    .select('kind')
    .in('kind', kinds)
    .in('status', [...ESTADOS_QUE_PRUEBAN_ATENCION])
    .gte('updated_at', desde)
    .limit(500)

  if (error) {
    throw new Error(
      `No se pudo saber qué tipos de trabajo siguen andando: ${describeDbError(error)}`,
    )
  }

  const atendidos = new Set<JobKind>()
  for (const fila of (data ?? []) as Array<Record<string, any>>) {
    if (typeof fila?.kind === 'string') atendidos.add(fila.kind as JobKind)
  }
  return atendidos
}

/**
 * Deja el trabajo en `failed` con un motivo que se entienda.
 *
 * El segundo `.eq('status', 'queued')` es el candado optimista: entre que se
 * listaron los candidatos y este UPDATE pueden haber pasado segundos, y en esos
 * segundos un worker pudo haberlo tomado. Si ya no está encolado, no se toca y
 * se devuelve `false`.
 */
async function darPorPerdido(
  db: JobsDb,
  jobId: string,
  kind: JobKind,
  esperaMs: number,
): Promise<boolean> {
  const { data, error } = await db
    .from(T.jobs)
    .update({
      status: 'failed' satisfies JobStatus,
      last_error: motivoDesatendido(kind, esperaMs),
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('id')

  if (error) {
    // Una fila que no se pudo marcar no puede cortar la barrida entera: las
    // demás corridas también están esperando que alguien las destrabe.
    console.error(
      `[jobs] no se pudo dar por perdido el trabajo ${jobId}: ${describeDbError(error)}`,
    )
    return false
  }

  if (Array.isArray(data)) return data.length > 0
  return Boolean(data)
}

/**
 * Lo que va a leer la persona en pantalla. Sin jerga, sin "handler no
 * registrado", y con algo para hacer al final.
 */
export function motivoDesatendido(kind: JobKind, esperaMs: number): string {
  const minutos = Math.max(1, Math.round(esperaMs / 60_000))
  const etapa = JOB_KIND_LABEL[kind] ?? 'Una parte de la revisión'
  return (
    `«${etapa}» quedó ${minutos} minutos esperando su turno y no llegamos a hacerla, ` +
    'así que la damos por no hecha. Lo que sí alcanzamos a revisar sigue valiendo. ' +
    'Podés volver a pedir la revisión cuando quieras y lo intentamos de nuevo.'
  )
}

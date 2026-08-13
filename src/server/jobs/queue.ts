/**
 * La cola de trabajos, sobre la tabla `public.jobs`.
 *
 * ## Por qué existe el lease
 *
 * Un trabajo tomado por un worker queda con `status = 'running'` y
 * `lease_until = ahora + N segundos`. Mientras el worker vive, va renovando ese
 * lease con `heartbeat()`. Si el proceso se muere (deploy, OOM, corte de luz),
 * nadie renueva: el lease vence y `requeueExpired()` devuelve el trabajo a
 * `queued`. Eso es lo que hace que **un trabajo encolado sobreviva a un reinicio
 * del worker** sin que nadie tenga que apretar nada.
 *
 * ## Contrato con el RPC `claim_job`
 *
 * Lo escribe el frente de datos. Asumimos que, de forma atómica:
 *   - elige el trabajo `queued` más viejo con `run_after <= now()` y `kind` en la lista,
 *   - le pone `status = 'running'`, `lease_until = now() + p_lease_seconds`,
 *   - **incrementa `attempts`**,
 *   - devuelve la fila de `jobs`.
 *
 * Ese incremento importa: `fail()` decide con el `attempts` que vino del claim.
 * Si el RPC no lo incrementara, los reintentos serían infinitos.
 */

import type { JobKind, JobRecord, JobStatus } from '@/lib/types/domain'
import { F, T } from '@/lib/db/tablas'
import { nextRunAfter, type BackoffOptions } from './backoff'
import { describeDbError, isMissingFunctionError, jobsDb } from './db'
import { describeError } from './errors'
import { reconcileRunStatus } from './reconcile'

/**
 * Cuánto vale un lease sin renovar.
 *
 * Era 300 s y eso costaba caro: cuando la instancia se muere (OOM en Vercel), el
 * trabajo queda inmovilizado los 300 s enteros antes de que `requeueExpired()`
 * lo rescate. Con `maxAttempts = 3` eso son veinte minutos de spinner antes de
 * que el usuario vea siquiera un error.
 *
 * 90 s es de sobra: el runner late cada 15 s (`HEARTBEAT_MS`), así que el lease
 * solo tiene que sobrevivir a cinco latidos perdidos seguidos. Si se perdieron
 * cinco, el worker no está vivo.
 */
export const DEFAULT_LEASE_SECONDS = 90
export const DEFAULT_MAX_ATTEMPTS = 3

/** Columnas de `jobs`, en un solo lugar para no repetir el string. */
const JOB_COLUMNS =
  'id, org_id, project_id, analysis_run_id, kind, status, payload, attempts, max_attempts, last_error, stage, progress, lease_until, run_after, created_at, updated_at'

/* ── Mapeo fila ⇄ dominio ─────────────────────────────────────────────── */

export function toJobRecord<TPayload = unknown>(row: Record<string, any>): JobRecord<TPayload> {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    projectId: row.project_id ?? null,
    analysisRunId: row.analysis_run_id ?? null,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    payload: (row.payload ?? {}) as TPayload,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
    lastError: row.last_error ?? null,
    stage: row.stage ?? null,
    progress: Number(row.progress ?? 0),
    leaseUntil: row.lease_until ?? null,
    createdAt: row.created_at ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? new Date().toISOString(),
  }
}

function toIso(value: Date | string | undefined | null): string | undefined {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

/* ── Encolar ─────────────────────────────────────────────────────────── */

export interface EnqueueInput<TPayload = unknown> {
  orgId: string
  projectId?: string | null
  analysisRunId?: string | null
  kind: JobKind
  payload: TPayload
  /** Para agendar a futuro (ej. reintentar una verificación en 10 minutos). */
  runAfter?: Date | string
  maxAttempts?: number
}

/** Devuelve el id del trabajo encolado. */
export async function enqueue<TPayload = unknown>(input: EnqueueInput<TPayload>): Promise<string> {
  if (!input.orgId) {
    throw new Error('No se puede encolar un trabajo sin organización.')
  }

  const db = await jobsDb()
  const { data, error } = await db
    .from(T.jobs)
    .insert({
      org_id: input.orgId,
      project_id: input.projectId ?? null,
      analysis_run_id: input.analysisRunId ?? null,
      kind: input.kind,
      status: 'queued' satisfies JobStatus,
      payload: input.payload ?? {},
      attempts: 0,
      max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      progress: 0,
      run_after: toIso(input.runAfter) ?? new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`No se pudo encolar el trabajo "${input.kind}": ${describeDbError(error)}`)
  }
  return String(data.id)
}

/** Encola varios de una. Devuelve los ids en el mismo orden. */
export async function enqueueMany(inputs: EnqueueInput[]): Promise<string[]> {
  const ids: string[] = []
  for (const input of inputs) ids.push(await enqueue(input))
  return ids
}

/* ── Un trabajo por corrida: encolar sin duplicar ─────────────────────── */

/**
 * Encolar es una escritura, y la regla del registro vale también acá: **un
 * handler puede correr dos veces**. Un `index_code` que muere entre el `enqueue`
 * y el guardado del avance de su etapa vuelve a encolar todo al reintentar, y
 * dos `run_checks` sobre la misma corrida son dos revisiones compitiendo por las
 * mismas filas de `findings`.
 *
 * La clave natural de estos trabajos es (`analysis_run_id`, `kind`): de cada
 * tipo hay a lo sumo uno por corrida. (`generate_video` es la excepción —hay
 * hasta tres— y por eso no usa esto.)
 */
export interface EnqueueDeCorridaInput<TPayload = unknown> extends EnqueueInput<TPayload> {
  /** Obligatorio: es la mitad de la clave natural. */
  analysisRunId: string
}

/**
 * Encola solo si la corrida no tiene ya un trabajo de ese tipo, **en el estado
 * que sea**. Que exista uno `failed` también frena: reencolarlo por la puerta de
 * atrás le devolvería intentos a algo que ya se dio por perdido.
 */
export async function encolarUnaVezPorCorrida<TPayload = unknown>(
  input: EnqueueDeCorridaInput<TPayload>,
): Promise<'encolado' | 'ya_existia'> {
  const db = await jobsDb()
  if (await hayTrabajoDeCorrida(db, input.analysisRunId, input.kind)) return 'ya_existia'
  await enqueue(input)
  return 'encolado'
}

/**
 * - `adelantado`: había uno esperando y ahora corre ya, con este payload.
 * - `ya_no_esperaba`: existe, pero alguien ya lo tomó (o terminó). No se toca.
 * - `encolado`: no existía ninguno y se creó.
 */
export type ResultadoAdelanto = 'adelantado' | 'ya_no_esperaba' | 'encolado'

/**
 * Adelanta un trabajo que estaba agendado a futuro, reemplazándole el payload.
 *
 * ## Para qué existe
 *
 * `index_code` encola la revisión **dos veces por adelantado**: una la corre el
 * agente de navegación al terminar (con la evidencia adentro) y la otra es una
 * red, agendada con `run_after` a futuro, que se dispara sola si el agente nunca
 * llega a correr. Esta función es el punto donde esas dos se vuelven una: el
 * agente no encola una revisión nueva, adelanta la que ya está esperando.
 *
 * ## La carrera, y por qué no hacen falta dos revisiones
 *
 * El caso feo es que el diferimiento venza justo cuando el agente termina: un
 * worker toma la red mientras nosotros intentamos adelantarla. El `UPDATE` lo
 * resuelve solo, sin transacción explícita, porque el `.eq('status','queued')`
 * es un compare-and-set sobre la misma fila que `claim_job` bloquea con
 * `for update`:
 *
 *   - si ganamos, la fila sigue `queued` y se actualiza; el claim posterior se
 *     la lleva con el payload nuevo;
 *   - si gana el claim, nuestro `UPDATE` espera el lock, reevalúa, ya no está
 *     `queued` y toca **cero filas**.
 *
 * En ese segundo caso NO se encola otra: la revisión ya está corriendo. Lo que
 * se pierde es la evidencia del navegador, y eso el informe lo sabe decir —los
 * chequeos que la necesitan quedan marcados como no revisados—. Duplicar la
 * revisión, en cambio, sería dos handlers borrando y reinsertando los mismos
 * `findings` a la vez.
 *
 * ## Compatibilidad
 *
 * Un `run_browser_agent` encolado por la versión anterior no tiene ninguna red
 * esperando. Por eso, y solo cuando no existe **ningún** trabajo de ese tipo en
 * la corrida, se encola uno nuevo: es el comportamiento viejo, intacto, para los
 * trabajos que ya estaban en la cola cuando salió el cambio.
 */
export async function adelantarOEncolar<TPayload = unknown>(
  input: EnqueueDeCorridaInput<TPayload>,
): Promise<ResultadoAdelanto> {
  const db = await jobsDb()
  const ahora = new Date().toISOString()

  const { data, error } = await db
    .from(T.jobs)
    .update({
      payload: input.payload ?? {},
      run_after: ahora,
      updated_at: ahora,
    })
    .eq('analysis_run_id', input.analysisRunId)
    .eq('kind', input.kind)
    .eq('status', 'queued')
    .select('id')

  if (error) {
    throw new Error(
      `No se pudo adelantar el trabajo "${input.kind}": ${describeDbError(error)}`,
    )
  }
  if (cuantasFilas(data) > 0) return 'adelantado'

  if (await hayTrabajoDeCorrida(db, input.analysisRunId, input.kind)) return 'ya_no_esperaba'

  await enqueue(input)
  return 'encolado'
}

/** ¿La corrida ya tiene un trabajo de ese tipo, en cualquier estado? */
async function hayTrabajoDeCorrida(
  db: Awaited<ReturnType<typeof jobsDb>>,
  analysisRunId: string,
  kind: JobKind,
): Promise<boolean> {
  const { data, error } = await db
    .from(T.jobs)
    .select('id')
    .eq('analysis_run_id', analysisRunId)
    .eq('kind', kind)
    .limit(1)

  if (error) {
    throw new Error(
      `No se pudo saber si la corrida ya tenía un "${kind}": ${describeDbError(error)}`,
    )
  }
  return cuantasFilas(data) > 0
}

/**
 * PostgREST devuelve un arreglo cuando se pide `.select()` sobre un `UPDATE`,
 * pero con `.single()`/`.maybeSingle()` devuelve el objeto suelto. Se contemplan
 * los dos para que quien llame no tenga que acordarse de cuál era.
 */
function cuantasFilas(data: unknown): number {
  if (Array.isArray(data)) return data.length
  return data ? 1 : 0
}

/* ── Tomar un trabajo ─────────────────────────────────────────────────── */

/**
 * Toma el próximo trabajo disponible de alguno de esos tipos.
 * `null` si no hay nada para hacer.
 */
export async function claim(
  kinds: JobKind[],
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<JobRecord | null> {
  if (kinds.length === 0) return null

  const db = await jobsDb()
  const { data, error } = await db.rpc(F.claimJob, {
    p_kinds: kinds,
    p_lease_seconds: Math.max(30, Math.round(leaseSeconds)),
  })

  if (error) {
    throw new Error(`No se pudo tomar un trabajo de la cola: ${describeDbError(error)}`)
  }

  // El RPC puede estar declarado `returns jobs` (objeto) o `returns setof jobs` (arreglo).
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  if (!tieneIdUsable(row)) return null
  return toJobRecord(row)
}

/**
 * NO BORRAR: esto no es código muerto, es la cicatriz de un bucle infinito real.
 *
 * Una función de Postgres declarada `returns <tipo compuesto>` (y no `returns setof`)
 * que hace `return null` NO devuelve cero filas: devuelve **una** fila con todas
 * las columnas en null. PostgREST la entrega como un objeto `{ id: null, kind: null, … }`,
 * que pasa limpito el `if (!row)` de arriba.
 *
 * Eso fue exactamente lo que pasó: `claim()` devolvía ese fantasma, `toJobRecord()`
 * lo convertía en `id: "null"` (el string), y el worker se ponía a "ejecutar" ese
 * trabajo inexistente ~2 veces por segundo, con la cola vacía, para siempre.
 *
 * La migración 0013 arregla la función; esta guarda es el cinturón: un trabajo sin
 * `id` usable no es un trabajo, es que no hay nada para hacer.
 */
function tieneIdUsable(row: Record<string, any>): boolean {
  const id = row.id
  if (id === null || id === undefined) return false
  return String(id).trim().length > 0
}

/* ── Latido ──────────────────────────────────────────────────────────── */

export interface HeartbeatInput {
  stage?: string
  progress?: number
  leaseSeconds?: number
}

/**
 * Extiende el lease y publica en qué anda el trabajo.
 * Llamarlo seguido (el runner lo hace cada 15 s) es lo que evita que otro worker
 * se lleve un trabajo que todavía está corriendo.
 */
export async function heartbeat(jobId: string, input: HeartbeatInput = {}): Promise<void> {
  const leaseSeconds = Math.max(30, Math.round(input.leaseSeconds ?? DEFAULT_LEASE_SECONDS))
  const patch: Record<string, unknown> = {
    lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (input.stage !== undefined) patch.stage = input.stage
  const progress = clampProgress(input.progress)
  if (progress !== undefined) patch.progress = progress

  const db = await jobsDb()
  const { error } = await db.from(T.jobs).update(patch).eq('id', jobId)
  if (error) {
    throw new Error(`No se pudo actualizar el estado del trabajo: ${describeDbError(error)}`)
  }
}

/* ── Cerrar el trabajo ───────────────────────────────────────────────── */

export async function succeed(jobId: string): Promise<void> {
  const db = await jobsDb()
  const { error } = await db
    .from(T.jobs)
    .update({
      status: 'succeeded' satisfies JobStatus,
      progress: 100,
      lease_until: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)

  if (error) {
    throw new Error(`No se pudo marcar el trabajo como terminado: ${describeDbError(error)}`)
  }
}

export interface FailOptions {
  /** `false` cuando reintentar no puede cambiar nada (payload inválido, handler ausente). */
  retry?: boolean
  /** Intentos ya consumidos. Si no viene, se lee de la base. */
  attempts?: number
  maxAttempts?: number
  backoff?: BackoffOptions
  now?: Date
}

export interface FailOutcome {
  status: Extract<JobStatus, 'queued' | 'failed'>
  attempts: number
  maxAttempts: number
  /** Cuándo vuelve a estar disponible. `null` si ya no se reintenta. */
  runAfter: string | null
  lastError: string
}

/**
 * Marca el intento como fallido. Si quedan intentos y el error es reintentable,
 * el trabajo vuelve a `queued` con backoff exponencial; si no, queda en `failed`.
 */
export async function fail(
  jobId: string,
  error: unknown,
  options: FailOptions = {},
): Promise<FailOutcome> {
  const db = await jobsDb()
  const lastError = describeError(error)

  let attempts = options.attempts
  let maxAttempts = options.maxAttempts
  if (attempts === undefined || maxAttempts === undefined) {
    const current = await getJob(jobId)
    attempts = attempts ?? current?.attempts ?? 1
    maxAttempts = maxAttempts ?? current?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  const wantsRetry = options.retry ?? true
  const hasAttemptsLeft = attempts < Math.max(1, maxAttempts)
  const willRetry = wantsRetry && hasAttemptsLeft

  const runAfter = willRetry
    ? nextRunAfter(attempts, options.backoff ?? { jitterRatio: 0.2 }, options.now ?? new Date())
    : null

  const patch: Record<string, unknown> = {
    status: (willRetry ? 'queued' : 'failed') satisfies JobStatus,
    last_error: lastError,
    lease_until: null,
    updated_at: new Date().toISOString(),
  }
  if (runAfter) patch.run_after = runAfter

  const { error: dbError } = await db.from(T.jobs).update(patch).eq('id', jobId)
  if (dbError) {
    throw new Error(`No se pudo registrar la falla del trabajo: ${describeDbError(dbError)}`)
  }

  return {
    status: willRetry ? 'queued' : 'failed',
    attempts,
    maxAttempts,
    runAfter,
    lastError,
  }
}

/**
 * Suelta el trabajo sin marcarlo como fallido: vuelve a `queued` ya mismo.
 * Lo usa el worker al apagarse con algo a medio hacer.
 */
export async function releaseLease(jobId: string, reason?: string): Promise<void> {
  const db = await jobsDb()
  const { error } = await db
    .from(T.jobs)
    .update({
      status: 'queued' satisfies JobStatus,
      lease_until: null,
      run_after: new Date().toISOString(),
      last_error: reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)

  if (error) {
    throw new Error(`No se pudo devolver el trabajo a la cola: ${describeDbError(error)}`)
  }
}

/** Cancela un trabajo que todavía no empezó. */
export async function cancel(jobId: string, reason?: string): Promise<void> {
  const db = await jobsDb()
  const { error } = await db
    .from(T.jobs)
    .update({
      status: 'cancelled' satisfies JobStatus,
      lease_until: null,
      last_error: reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', 'queued')

  if (error) {
    throw new Error(`No se pudo cancelar el trabajo: ${describeDbError(error)}`)
  }
}

/* ── Recuperar trabajos huérfanos ────────────────────────────────────── */

/**
 * Devuelve a la cola todo lo que quedó `running` con el lease vencido, y cierra
 * las corridas de los que ya no vuelven.
 *
 * ## Por qué acá se reconcilia
 *
 * El RPC marca `failed` **en SQL** a los trabajos que perdieron el lease con los
 * intentos agotados. Ese camino nunca pasa por el runner, así que nunca pasaba
 * por `reconcileRunStatus()`: el trabajo quedaba `failed` y su corrida `running`
 * para siempre, con la pantalla de hallazgos diciendo "Estamos revisando tu app"
 * hasta el fin de los tiempos. Pasó con dos corridas reales (ver migración 0016).
 *
 * Desde 0016 el RPC devuelve qué tocó y en qué estado quedó, que es lo único que
 * faltaba para poder avisarle a la corrida correcta.
 */
export async function requeueExpired(): Promise<number> {
  const db = await jobsDb()
  const { data, error } = await db.rpc(F.requeueExpiredJobs)
  if (error) {
    throw new Error(`No se pudieron recuperar los trabajos vencidos: ${describeDbError(error)}`)
  }

  await cerrarCorridasDeLosQueYaNoVuelven(data)

  if (typeof data === 'number') return data
  if (Array.isArray(data)) return data.length
  if (data && typeof data === 'object' && 'count' in data) return Number((data as any).count) || 0
  return 0
}

/**
 * Reconcilia una vez por corrida distinta que haya quedado con algún trabajo en
 * `failed`. Tolera que el RPC todavía sea el viejo (un `int`): en ese caso no hay
 * filas de las que deducir nada y no se hace nada.
 *
 * Un cierre que falla no puede tumbar el rescate: los trabajos ya volvieron a la
 * cola, que es lo importante, y la corrida se reconcilia sola en la próxima
 * pasada o cuando termine cualquier otro trabajo suyo. Por eso se registra y se
 * sigue, en vez de cortar y dejar a las demás corridas sin revisar.
 */
async function cerrarCorridasDeLosQueYaNoVuelven(data: unknown): Promise<void> {
  if (!Array.isArray(data)) return

  const corridas = new Set<string>()
  for (const fila of data as Array<Record<string, any>>) {
    if (!fila || fila.status !== 'failed') continue
    const runId = fila.analysis_run_id
    if (typeof runId === 'string' && runId.length > 0) corridas.add(runId)
  }

  for (const analysisRunId of corridas) {
    try {
      await reconcileRunStatus(analysisRunId)
    } catch (error) {
      console.error(
        `[jobs] no se pudo cerrar la corrida ${analysisRunId} después de rescatar sus trabajos ` +
          `vencidos: ${describeError(error)}`,
      )
    }
  }
}

/* ── Candado: un solo tick a la vez ──────────────────────────────────────── */

/** Nombre del único candado que existe hoy: el de la tanda del cron. */
export const CANDADO_TICK = 'worker_tick'

/**
 * - `tomado`: el candado es tuyo, tenés que soltarlo.
 * - `ocupado`: lo tiene otro y todavía no venció. No hagas nada.
 * - `sin-candado`: la base no pudo darnos un candado (RPC ausente o respuesta
 *   inesperada). Se sigue igual, que es exactamente el comportamiento de antes
 *   de que el candado existiera.
 */
export type EstadoCandado = 'tomado' | 'ocupado' | 'sin-candado'

/**
 * Intenta tomar un candado de worker por `ttlSeconds`.
 *
 * ## Por qué "sin-candado" en vez de fallar
 *
 * Si el RPC no existe todavía (la migración 0016 se aplica después del deploy) o
 * contesta algo que no es un booleano, la alternativa sería frenar la cola. Un
 * candado roto no puede ser peor que no tener candado: fallar cerrado dejaría la
 * cola muerta hasta que alguien lo note. Se avisa fuerte por consola y se sigue.
 * Cualquier OTRO error de base sí revienta: eso no es "no hay candado", es que la
 * base no está respondiendo, y ahí procesar la cola no tiene sentido.
 */
export async function tomarCandado(
  nombre: string,
  titular: string,
  ttlSeconds: number,
): Promise<EstadoCandado> {
  const db = await jobsDb()
  const { data, error } = await db.rpc(F.tryAcquireWorkerLock, {
    p_name: nombre,
    p_holder: titular,
    p_ttl_seconds: Math.max(5, Math.round(ttlSeconds)),
  })

  if (error) {
    if (isMissingFunctionError(error)) {
      console.warn(
        `[jobs] el candado "${nombre}" no existe en la base todavía (falta aplicar la migración 0016). ` +
          'La tanda sigue sin candado: dos ticks pueden pisarse.',
      )
      return 'sin-candado'
    }
    throw new Error(`No se pudo tomar el candado "${nombre}": ${describeDbError(error)}`)
  }

  if (data === true) return 'tomado'
  if (data === false) return 'ocupado'

  console.warn(
    `[jobs] el candado "${nombre}" contestó ${JSON.stringify(data)} en vez de un booleano. ` +
      'La tanda sigue sin candado.',
  )
  return 'sin-candado'
}

/**
 * Suelta el candado. `true` si de verdad era nuestro.
 *
 * No tira: esto corre siempre en un `finally`, y una excepción acá taparía el
 * resultado real de la tanda. Además, no soltarlo no rompe nada: el candado
 * vence solo.
 */
export async function soltarCandado(nombre: string, titular: string): Promise<boolean> {
  try {
    const db = await jobsDb()
    const { data, error } = await db.rpc(F.releaseWorkerLock, {
      p_name: nombre,
      p_holder: titular,
    })
    if (error) {
      if (!isMissingFunctionError(error)) {
        console.error(`[jobs] no se pudo soltar el candado "${nombre}": ${describeDbError(error)}`)
      }
      return false
    }
    return data === true
  } catch (error) {
    console.error(`[jobs] no se pudo soltar el candado "${nombre}": ${describeError(error)}`)
    return false
  }
}

/* ── Lecturas ────────────────────────────────────────────────────────── */

export async function getJob<TPayload = unknown>(
  jobId: string,
): Promise<JobRecord<TPayload> | null> {
  const db = await jobsDb()
  const { data, error } = await db.from(T.jobs).select(JOB_COLUMNS).eq('id', jobId).maybeSingle()
  if (error) {
    throw new Error(`No se pudo leer el trabajo: ${describeDbError(error)}`)
  }
  return data ? toJobRecord<TPayload>(data) : null
}

export interface ListJobsFilter {
  orgId?: string
  projectId?: string
  analysisRunId?: string
  statuses?: JobStatus[]
  limit?: number
}

export async function listJobs(filter: ListJobsFilter = {}): Promise<JobRecord[]> {
  const db = await jobsDb()
  let query = db.from(T.jobs).select(JOB_COLUMNS).order('created_at', { ascending: true })

  if (filter.orgId) query = query.eq('org_id', filter.orgId)
  if (filter.projectId) query = query.eq('project_id', filter.projectId)
  if (filter.analysisRunId) query = query.eq('analysis_run_id', filter.analysisRunId)
  if (filter.statuses?.length) query = query.in('status', filter.statuses)
  query = query.limit(filter.limit ?? 100)

  const { data, error } = await query
  if (error) {
    throw new Error(`No se pudieron listar los trabajos: ${describeDbError(error)}`)
  }
  return (data ?? []).map((row: Record<string, any>) => toJobRecord(row))
}

/** Guarda el payload completo (lo usa el pipeline por etapas). */
export async function savePayload(jobId: string, payload: unknown): Promise<void> {
  const db = await jobsDb()
  const { error } = await db
    .from(T.jobs)
    .update({ payload, updated_at: new Date().toISOString() })
    .eq('id', jobId)

  if (error) {
    throw new Error(`No se pudo guardar el avance del trabajo: ${describeDbError(error)}`)
  }
}

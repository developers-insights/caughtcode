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
import { describeDbError, jobsDb } from './db'
import { describeError } from './errors'

export const DEFAULT_LEASE_SECONDS = 300
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
 * Devuelve a la cola todo lo que quedó `running` con el lease vencido.
 * Esto es lo que rescata los trabajos de un worker que se murió.
 */
export async function requeueExpired(): Promise<number> {
  const db = await jobsDb()
  const { data, error } = await db.rpc(F.requeueExpiredJobs)
  if (error) {
    throw new Error(`No se pudieron recuperar los trabajos vencidos: ${describeDbError(error)}`)
  }
  if (typeof data === 'number') return data
  if (Array.isArray(data)) return data.length
  if (data && typeof data === 'object' && 'count' in data) return Number((data as any).count) || 0
  return 0
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

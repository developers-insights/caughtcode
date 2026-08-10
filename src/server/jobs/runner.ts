/**
 * El loop: tomar un trabajo, ejecutarlo, latir mientras dura, cerrarlo bien.
 *
 * Lo usan dos cosas distintas y por eso vive acá y no en el script del worker:
 *   - `scripts/worker.ts` (proceso largo, concurrencia configurable),
 *   - `POST /api/worker/tick` (disparo desde Vercel Cron, tanda acotada).
 *
 * ## Qué garantiza
 *
 * - **Nadie pisa a nadie**: el trabajo se toma con lease; mientras el handler
 *   corre, el latido lo renueva cada 15 s.
 * - **Nada queda colgado**: si el proceso muere, el lease vence y
 *   `requeueExpired()` devuelve el trabajo a la cola.
 * - **El fallo tiene backoff**: `2^intentos * 30s`, con techo de 15 minutos, y
 *   `failed` definitivo al pasarse de `max_attempts`.
 * - **Todo lo caro queda registrado**: cada `ctx.reportCost` va a `usage_events`
 *   y al terminar se acumula en `analysis_runs.cost_breakdown`.
 */

import type { CostEntry, JobKind, JobRecord } from '@/lib/types/domain'
import { recordCost, runCost } from '@/server/cost/ledger'
import { describeError, isRetryable } from './errors'
import { publishRunProgress, reopenRun } from './progress'
import { esTrabajoDeRevision, reconcileRunStatus } from './reconcile'
import { claim, fail, heartbeat, succeed, DEFAULT_LEASE_SECONDS } from './queue'
import { JOB_KIND_LABEL, getHandler, type JobContext } from './registry'

export const HEARTBEAT_MS = 15_000

export interface RunnerOptions {
  /** Qué tipos atiende este worker. Por defecto, todos. */
  kinds?: JobKind[]
  leaseSeconds?: number
  heartbeatMs?: number
  workerId?: string
  log?: (message: string) => void
  /** Se dispara al apagar: los handlers lo reciben en `ctx.signal`. */
  signal?: AbortSignal
  /** Aviso temprano de que se tomó un trabajo (el worker lo usa para el apagado). */
  onClaimed?: (job: JobRecord) => void
}

export type JobOutcomeKind = 'succeeded' | 'retrying' | 'failed'

export interface JobOutcome {
  jobId: string
  kind: JobKind
  outcome: JobOutcomeKind
  attempts: number
  maxAttempts: number
  durationMs: number
  costUsd: number
  error?: string
  /** Cuándo se reintenta, si corresponde. */
  runAfter?: string | null
}

function defaultLog(message: string): void {
  console.log(message)
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => Boolean(s))
  if (present.length === 0) return new AbortController().signal
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

/* ── Ejecutar un trabajo ya tomado ───────────────────────────────────── */

export async function runClaimedJob(
  job: JobRecord,
  options: RunnerOptions = {},
): Promise<JobOutcome> {
  const log = options.log ?? defaultLog
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const startedAt = Date.now()

  const controller = new AbortController()
  const signal = combineSignals([options.signal, controller.signal])

  const costs: CostEntry[] = []
  let currentStage: string | null = job.stage ?? JOB_KIND_LABEL[job.kind] ?? null
  let currentProgress = job.progress ?? 0

  const prefix = `[${job.kind} ${job.id.slice(0, 8)}]`
  const jobLog = (message: string) => log(`${prefix} ${message}`)

  const pushState = async () => {
    await heartbeat(job.id, {
      stage: currentStage ?? undefined,
      progress: currentProgress,
      leaseSeconds,
    })
    await publishRunProgress(job.analysisRunId, {
      stage: currentStage,
      progress: currentProgress,
    })
  }

  const ctx: JobContext = {
    jobId: job.id,
    orgId: job.orgId,
    projectId: job.projectId,
    analysisRunId: job.analysisRunId,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    signal,
    heartbeat: async (stage, progress) => {
      if (stage !== undefined) currentStage = stage
      if (progress !== undefined) currentProgress = progress
      await pushState()
    },
    log: jobLog,
    reportCost: async (entry) => {
      costs.push(entry)
      await recordCost(job.orgId, job.projectId, entry, { analysisRunId: job.analysisRunId })
    },
  }

  // Latido de fondo: aunque el handler no llame a `ctx.heartbeat`, el lease se renueva.
  const ticker = setInterval(() => {
    void pushState().catch((error) => {
      jobLog(`No se pudo renovar el lease: ${describeError(error)}`)
    })
  }, heartbeatMs)

  try {
    // Que este trabajo esté corriendo desmiente cualquier cierre anterior de la
    // corrida. Se reabre antes de tocar nada más, para que el error del intento
    // que falló no siga en pantalla mientras este intento avanza.
    if (esTrabajoDeRevision(job.kind)) await reopenRun(job.analysisRunId)

    await pushState()
    const handler = getHandler(job.kind)
    await handler(job.payload, ctx)

    await succeed(job.id)
    const totalUsd = await flushCosts(job, costs, jobLog)

    await publishRunProgress(job.analysisRunId, { stage: currentStage, progress: currentProgress })
    await cerrarCorridaSiTermino(job, jobLog)

    return {
      jobId: job.id,
      kind: job.kind,
      outcome: 'succeeded',
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      durationMs: Date.now() - startedAt,
      costUsd: totalUsd,
    }
  } catch (error) {
    const retry = isRetryable(error)
    const outcome = await fail(job.id, error, {
      retry,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    })
    const totalUsd = await flushCosts(job, costs, jobLog)

    jobLog(
      outcome.status === 'queued'
        ? `Falló (intento ${outcome.attempts}/${outcome.maxAttempts}). Reintenta a las ${outcome.runAfter}. Motivo: ${outcome.lastError}`
        : `Falló definitivamente tras ${outcome.attempts} intento(s). Motivo: ${outcome.lastError}`,
    )

    // Solo cuando ya no se reintenta. Con el trabajo de vuelta en la cola la
    // corrida sigue en marcha, y decir que falló sería adelantarse.
    if (outcome.status === 'failed') await cerrarCorridaSiTermino(job, jobLog)

    return {
      jobId: job.id,
      kind: job.kind,
      outcome: outcome.status === 'queued' ? 'retrying' : 'failed',
      attempts: outcome.attempts,
      maxAttempts: outcome.maxAttempts,
      durationMs: Date.now() - startedAt,
      costUsd: totalUsd,
      error: outcome.lastError,
      runAfter: outcome.runAfter,
    }
  } finally {
    clearInterval(ticker)
    controller.abort()
  }
}

/**
 * Cierra la corrida si este trabajo era el último que le quedaba.
 *
 * No puede tumbar al trabajo: ya terminó y su resultado está escrito. Si el
 * cierre falla, queda dicho en el registro y la corrida se reconcilia sola
 * cuando termine cualquier otro trabajo suyo.
 */
async function cerrarCorridaSiTermino(
  job: JobRecord,
  jobLog: (message: string) => void,
): Promise<void> {
  if (!job.analysisRunId) return
  try {
    const { status, pendientes } = await reconcileRunStatus(job.analysisRunId)
    if (status) jobLog(`La auditoría quedó en "${status}".`)
    else if (pendientes > 0) jobLog(`La auditoría sigue: quedan ${pendientes} trabajo(s).`)
  } catch (error) {
    jobLog(`No pudimos actualizar el estado de la auditoría: ${describeError(error)}`)
  }
}

/**
 * Acumula el costo del trabajo en la corrida. Si esto falla no tiramos abajo el
 * trabajo: el gasto ya quedó en `usage_events`, que es la fuente de verdad.
 */
async function flushCosts(
  job: JobRecord,
  costs: CostEntry[],
  jobLog: (message: string) => void,
): Promise<number> {
  const totalUsd = costs.reduce((sum, entry) => sum + entry.costUsd, 0)
  if (!job.analysisRunId || costs.length === 0) return totalUsd
  try {
    const breakdown = await runCost(job.analysisRunId, costs)
    return breakdown.totalUsd
  } catch (error) {
    jobLog(`No se pudo acumular el costo en la corrida: ${describeError(error)}`)
    return totalUsd
  }
}

/* ── Tomar y ejecutar ────────────────────────────────────────────────── */

/** Toma el próximo trabajo y lo ejecuta. `null` si la cola está vacía. */
export async function processNextJob(options: RunnerOptions = {}): Promise<JobOutcome | null> {
  const kinds = options.kinds ?? (Object.keys(JOB_KIND_LABEL) as JobKind[])
  const job = await claim(kinds, options.leaseSeconds ?? DEFAULT_LEASE_SECONDS)
  if (!job) return null
  options.onClaimed?.(job)
  return runClaimedJob(job, options)
}

export interface BatchOptions extends RunnerOptions {
  /** Cuántos trabajos como mucho en esta tanda. */
  max?: number
  /** Momento (ms desde epoch) después del cual no se toman trabajos nuevos. */
  deadlineAt?: number
}

export interface BatchSummary {
  procesados: number
  exitosos: number
  reintentando: number
  fallidos: number
  costoUsd: number
  detalles: JobOutcome[]
  /** `true` si cortó por tiempo o por tope, no por cola vacía. */
  quedanTrabajos: boolean
}

/** Procesa hasta `max` trabajos, respetando el tiempo disponible. */
export async function processBatch(options: BatchOptions = {}): Promise<BatchSummary> {
  const max = Math.max(1, options.max ?? 3)
  const detalles: JobOutcome[] = []
  let quedanTrabajos = false

  for (let index = 0; index < max; index += 1) {
    if (options.deadlineAt && Date.now() >= options.deadlineAt) {
      quedanTrabajos = true
      break
    }
    if (options.signal?.aborted) {
      quedanTrabajos = true
      break
    }

    const outcome = await processNextJob(options)
    if (!outcome) break
    detalles.push(outcome)

    if (index === max - 1) quedanTrabajos = true
  }

  return {
    procesados: detalles.length,
    exitosos: detalles.filter((d) => d.outcome === 'succeeded').length,
    reintentando: detalles.filter((d) => d.outcome === 'retrying').length,
    fallidos: detalles.filter((d) => d.outcome === 'failed').length,
    costoUsd: Math.round(detalles.reduce((sum, d) => sum + d.costUsd, 0) * 1_000_000) / 1_000_000,
    detalles,
    quedanTrabajos,
  }
}

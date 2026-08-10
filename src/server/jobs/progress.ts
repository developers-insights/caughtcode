/**
 * Progreso de una corrida, para que la UI muestre hallazgos **a medida que
 * aparecen** en vez de una barra girando ocho minutos.
 *
 * El worker escribe en `analysis_runs.stage/progress/status`; la UI se suscribe
 * a los cambios de esa fila por Supabase Realtime y se entera sola. Por eso
 * todo lo que se escribe acá tiene que ser mostrable tal cual: `stage` es el
 * texto que lee el usuario, sin jerga.
 */

import type { AnalysisRun, CostBreakdown, RunStatus } from '@/lib/types/domain'
import { T } from '@/lib/db/tablas'
import { describeDbError, jobsDb } from './db'

/**
 * Nombre del canal de Realtime para una corrida.
 * La UI hace: `supabase.channel(runProgressChannel(id)).on('postgres_changes', …)`.
 */
export function runProgressChannel(analysisRunId: string): string {
  return `analysis_run:${analysisRunId}`
}

export interface RunProgressUpdate {
  /** Texto que ve el usuario. Ej.: "Revisando quién puede ver qué". */
  stage?: string | null
  /** 0–100. */
  progress?: number
  status?: RunStatus
  error?: string | null
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Publica el avance de la corrida. Silencioso si `analysisRunId` es nulo. */
export async function publishRunProgress(
  analysisRunId: string | null | undefined,
  update: RunProgressUpdate,
): Promise<void> {
  if (!analysisRunId) return

  const patch: Record<string, unknown> = {}
  if (update.stage !== undefined) patch.stage = update.stage
  const progress = clampProgress(update.progress)
  if (progress !== undefined) patch.progress = progress
  if (update.status !== undefined) patch.status = update.status
  if (update.error !== undefined) patch.error = update.error
  if (Object.keys(patch).length === 0) return

  const db = await jobsDb()
  const { error } = await db.from(T.analysisRuns).update(patch).eq('id', analysisRunId)
  if (error) {
    throw new Error(`No se pudo publicar el avance de la corrida: ${describeDbError(error)}`)
  }
}

export async function markRunStarted(analysisRunId: string, stage?: string): Promise<void> {
  const db = await jobsDb()
  const { error } = await db
    .from(T.analysisRuns)
    .update({
      status: 'running' satisfies RunStatus,
      stage: stage ?? 'Arrancando',
      progress: 0,
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq('id', analysisRunId)

  if (error) {
    throw new Error(`No se pudo marcar el inicio de la corrida: ${describeDbError(error)}`)
  }
}

/** Estados en los que una corrida ya se había dado por cerrada. */
export const ESTADOS_CERRADOS = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[]

/**
 * Vuelve a abrir una corrida que estaba cerrada porque uno de sus trabajos
 * arrancó de nuevo, y **borra el error del intento anterior**.
 *
 * Esto es la mitad del bug de producción: un intento falló, dejó la corrida en
 * `failed` con su mensaje, el trabajo se reencoló y corrió perfecto — y el
 * mensaje viejo siguió ahí, tapando 180 hallazgos con un cartel de "no pudimos
 * terminar". Un error de un intento anterior no puede sobrevivir a uno que
 * salió bien: mientras el trabajo corre no tenemos con qué respaldarlo.
 *
 * El filtro por estado es a propósito: si la corrida ya estaba `running` no se
 * toca nada, así dos workers no se pisan ni se reinicia el avance en pantalla.
 */
export async function reopenRun(analysisRunId: string | null | undefined): Promise<void> {
  if (!analysisRunId) return

  const db = await jobsDb()
  const { error } = await db
    .from(T.analysisRuns)
    .update({
      status: 'running' satisfies RunStatus,
      error: null,
      finished_at: null,
    })
    .eq('id', analysisRunId)
    .in('status', [...ESTADOS_CERRADOS])

  if (error) {
    throw new Error(`No se pudo reabrir la corrida: ${describeDbError(error)}`)
  }
}

export interface MarkRunFinishedInput {
  status: Extract<RunStatus, 'succeeded' | 'partial' | 'failed' | 'cancelled'>
  stage?: string | null
  error?: string | null
  costBreakdown?: CostBreakdown | null
}

export async function markRunFinished(
  analysisRunId: string,
  input: MarkRunFinishedInput,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    progress: input.status === 'succeeded' ? 100 : undefined,
    finished_at: new Date().toISOString(),
    error: input.error ?? null,
  }
  if (input.stage !== undefined) patch.stage = input.stage
  if (input.costBreakdown !== undefined) patch.cost_breakdown = input.costBreakdown
  if (patch.progress === undefined) delete patch.progress

  const db = await jobsDb()
  const { error } = await db.from(T.analysisRuns).update(patch).eq('id', analysisRunId)
  if (error) {
    throw new Error(`No se pudo cerrar la corrida: ${describeDbError(error)}`)
  }
}

/* ── Lectura ─────────────────────────────────────────────────────────── */

function toAnalysisRun(row: Record<string, any>): AnalysisRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: row.status as RunStatus,
    stage: row.stage ?? null,
    progress: Number(row.progress ?? 0),
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    costBreakdown: (row.cost_breakdown as CostBreakdown | null) ?? null,
    error: row.error ?? null,
  }
}

const RUN_COLUMNS =
  'id, project_id, status, stage, progress, started_at, finished_at, cost_breakdown, error'

/**
 * Lectura desde un Server Component o Route Handler: usa el cliente de servidor,
 * o sea que respeta la sesión del usuario y sus policies de RLS.
 *
 * El import es dinámico porque `@/lib/supabase/server` usa `next/headers`, que
 * no existe fuera del runtime de Next (el worker importa este mismo archivo).
 */
export async function readRunProgress(analysisRunId: string): Promise<AnalysisRun | null> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data, error } = await supabase
    .from(T.analysisRuns)
    .select(RUN_COLUMNS)
    .eq('id', analysisRunId)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer el estado de la corrida: ${describeDbError(error)}`)
  }
  return data ? toAnalysisRun(data as Record<string, any>) : null
}

/** Igual que `readRunProgress` pero con permisos de servicio (worker, cron). */
export async function readRunProgressAsAdmin(analysisRunId: string): Promise<AnalysisRun | null> {
  const db = await jobsDb()
  const { data, error } = await db
    .from(T.analysisRuns)
    .select(RUN_COLUMNS)
    .eq('id', analysisRunId)
    .maybeSingle()

  if (error) {
    throw new Error(`No se pudo leer el estado de la corrida: ${describeDbError(error)}`)
  }
  return data ? toAnalysisRun(data) : null
}

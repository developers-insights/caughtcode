/**
 * Pipeline por etapas reanudable.
 *
 * El problema concreto: indexar un repo grande son minutos y varios pasos.
 * Si el paso 4 se cae, rehacer los pasos 1–3 es tirar plata y tiempo (y es lo
 * que rompe el procesamiento monolítico en repos grandes). Acá cada etapa
 * guarda su resultado en `jobs.payload.stageResults`; al reintentar, las etapas
 * ya terminadas se saltean y se sigue desde donde quedó.
 *
 * ## Regla para quien escribe etapas
 *
 * El resultado de una etapa **es chico o no se guarda**. Si tu etapa produce un
 * índice de 20 MB, guardalo vos en su tabla y devolvé el identificador
 * (`{ codeIndexId }`). Si devolvés el blob entero, `runStages` corta con un
 * error explícito en vez de reventar la fila de `jobs` en silencio.
 */

import { JobAbortedError, JobError } from './errors'
import { getJob, savePayload } from './queue'
import type { JobContext } from './registry'

/** Clave reservada dentro de `jobs.payload`. Ningún handler debería usarla. */
export const STAGE_RESULTS_KEY = 'stageResults'

/** 32 KB por etapa. Más que eso es un blob y va a una tabla, no al payload. */
export const MAX_STAGE_RESULT_BYTES = 32 * 1024

export interface StageRunContext {
  ctx: JobContext
  /** Resultados de las etapas ya terminadas, por nombre. */
  results: Readonly<Record<string, unknown>>
  get<T = unknown>(stageName: string): T | undefined
  /** Latido intermedio dentro de una etapa larga. `progress` es 0–100 global. */
  heartbeat(progress?: number): Promise<void>
}

export interface StageDefinition<TResult = unknown> {
  /** Identificador estable. Si lo cambiás, la etapa se vuelve a correr. */
  name: string
  /** Texto que ve el usuario mientras corre. Sin jerga. */
  label?: string
  /** Progreso global (0–100) al terminar esta etapa. Si falta, se reparte parejo. */
  progress?: number
  /** `false` = etapa de puro efecto: se marca hecha pero no se guarda resultado. */
  persist?: boolean
  run: (helper: StageRunContext) => Promise<TResult>
}

interface StoredStage {
  at: string
  result: unknown
  persisted: boolean
}

export interface StageStore {
  load(jobId: string): Promise<Record<string, unknown>>
  save(jobId: string, payload: Record<string, unknown>): Promise<void>
}

/** Store por defecto: la columna `payload` de la fila del trabajo. */
export const jobPayloadStore: StageStore = {
  async load(jobId) {
    const job = await getJob<Record<string, unknown>>(jobId)
    if (!job) throw new JobError(`El trabajo ${jobId} ya no existe.`, { retryable: false })
    return (job.payload ?? {}) as Record<string, unknown>
  },
  async save(jobId, payload) {
    await savePayload(jobId, payload)
  },
}

export interface RunStagesOptions {
  store?: StageStore
  maxResultBytes?: number
}

function readStoredStages(payload: Record<string, unknown>): Record<string, StoredStage> {
  const raw = payload[STAGE_RESULTS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, StoredStage>
}

function assertResultFits(stageName: string, result: unknown, maxBytes: number): void {
  let serialized: string
  try {
    serialized = JSON.stringify(result ?? null)
  } catch {
    throw new JobError(
      `La etapa "${stageName}" devolvió algo que no se puede guardar (referencias circulares). ` +
        'Devolvé un identificador, no el objeto entero.',
      { retryable: false, code: 'etapa_no_serializable' },
    )
  }
  if (serialized.length > maxBytes) {
    throw new JobError(
      `La etapa "${stageName}" devolvió ${Math.round(serialized.length / 1024)} KB y el límite es ` +
        `${Math.round(maxBytes / 1024)} KB. Guardá el resultado en su tabla y devolvé el identificador, ` +
        'o marcá la etapa con `persist: false`.',
      { retryable: false, code: 'etapa_demasiado_grande' },
    )
  }
}

/**
 * Corre las etapas en orden, salteando las que ya terminaron en un intento previo.
 * Devuelve los resultados de todas las etapas persistidas, por nombre.
 */
export async function runStages(
  ctx: JobContext,
  stages: StageDefinition[],
  options: RunStagesOptions = {},
): Promise<Record<string, unknown>> {
  const store = options.store ?? jobPayloadStore
  const maxBytes = options.maxResultBytes ?? MAX_STAGE_RESULT_BYTES

  const seen = new Set<string>()
  for (const stage of stages) {
    if (seen.has(stage.name)) {
      throw new JobError(`Hay dos etapas con el mismo nombre: "${stage.name}".`, {
        retryable: false,
        code: 'etapas_duplicadas',
      })
    }
    seen.add(stage.name)
  }

  const payload = await store.load(ctx.jobId)
  const stored = readStoredStages(payload)

  const results: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(stored)) {
    if (entry?.persisted !== false) results[name] = entry?.result
  }

  const helper = (progressAtEnd: number): StageRunContext => ({
    ctx,
    results,
    get: <T,>(stageName: string) => results[stageName] as T | undefined,
    heartbeat: async (progress?: number) => {
      await ctx.heartbeat(undefined, progress ?? progressAtEnd)
    },
  })

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]
    const progressAtEnd = stage.progress ?? Math.round(((index + 1) / stages.length) * 100)
    const label = stage.label ?? stage.name

    if (stored[stage.name]) {
      ctx.log(`Etapa "${stage.name}" ya estaba hecha, se saltea.`)
      continue
    }

    if (ctx.signal.aborted) throw new JobAbortedError()

    await ctx.heartbeat(label, Math.round((index / stages.length) * 100))
    ctx.log(`Etapa "${stage.name}" arrancando.`)

    const result = await stage.run(helper(progressAtEnd))

    const persisted = stage.persist !== false
    if (persisted) {
      assertResultFits(stage.name, result, maxBytes)
      results[stage.name] = result
    }

    stored[stage.name] = {
      at: new Date().toISOString(),
      result: persisted ? (result ?? null) : null,
      persisted,
    }
    payload[STAGE_RESULTS_KEY] = stored
    await store.save(ctx.jobId, payload)

    await ctx.heartbeat(label, progressAtEnd)
    ctx.log(`Etapa "${stage.name}" lista.`)
  }

  return results
}

/** Qué etapas ya están hechas, según el payload guardado. */
export function completedStages(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) return []
  return Object.keys(readStoredStages(payload))
}

/** Borra el avance para forzar que todo se rehaga desde cero. */
export async function clearStageResults(
  jobId: string,
  options: RunStagesOptions = {},
): Promise<void> {
  const store = options.store ?? jobPayloadStore
  const payload = await store.load(jobId)
  delete payload[STAGE_RESULTS_KEY]
  await store.save(jobId, payload)
}

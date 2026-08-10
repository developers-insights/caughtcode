/**
 * Libro de costos.
 *
 * Dos cosas distintas viven acá:
 *
 * - **Lo que ya se gastó** (`recordCost`, `runCost`): cada operación cara deja
 *   su renglón en `usage_events` y se acumula en `analysis_runs.cost_breakdown`.
 *   Sin esto no se puede fijar precio ni ver que una regresión duplicó el costo.
 * - **Lo que va a costar** (`estimate`): el número que se le muestra al usuario
 *   *antes* de gastar, en dólares y en unidades concretas. Nunca "créditos".
 */

import type { CostBreakdown, CostCategory, CostEntry, JobKind } from '@/lib/types/domain'
import { T } from '@/lib/db/tablas'
import { describeDbError, isMissingColumnError, jobsDb } from '@/server/jobs/db'
import {
  BROWSER_SESSION_USD,
  NARRATION_CHARS_PER_SECOND,
  browserAgentCostUsd,
  formatUsd,
  llmCostUsd,
  pluralize,
  renderCostUsd,
  roundUsd,
  storageCostUsd,
  ttsCostUsd,
} from './pricing'

/* ── Acumulación ─────────────────────────────────────────────────────── */

function entryKey(entry: CostEntry): string {
  return `${entry.category}|${entry.unitLabel}|${entry.detail ?? ''}`
}

/** Junta renglones equivalentes sumando unidades y plata. */
export function mergeEntries(...groups: CostEntry[][]): CostEntry[] {
  const merged = new Map<string, CostEntry>()
  for (const group of groups) {
    for (const entry of group) {
      const key = entryKey(entry)
      const existing = merged.get(key)
      if (existing) {
        existing.units = roundUsd(existing.units + entry.units)
        existing.costUsd = roundUsd(existing.costUsd + entry.costUsd)
      } else {
        merged.set(key, { ...entry })
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.costUsd - a.costUsd)
}

export function buildBreakdown(entries: CostEntry[]): CostBreakdown {
  const merged = mergeEntries(entries)
  return {
    entries: merged,
    totalUsd: roundUsd(merged.reduce((sum, entry) => sum + entry.costUsd, 0)),
  }
}

/* ── Registrar lo gastado ────────────────────────────────────────────── */

export interface RecordCostOptions {
  analysisRunId?: string | null
}

/**
 * Deja el renglón en `usage_events`.
 *
 * `analysis_run_id` y `detail` son columnas que le pedimos al frente de datos
 * (ver el reporte). Si todavía no existen, el insert se reintenta sin ellas en
 * vez de tirar todo abajo: preferimos perder granularidad antes que perder el
 * registro del gasto.
 */
export async function recordCost(
  orgId: string,
  projectId: string | null,
  entry: CostEntry,
  options: RecordCostOptions = {},
): Promise<void> {
  const db = await jobsDb()

  const base = {
    org_id: orgId,
    project_id: projectId,
    kind: entry.category,
    units: entry.units,
    unit_label: entry.unitLabel,
    cost_usd: entry.costUsd,
  }

  const withExtras = {
    ...base,
    analysis_run_id: options.analysisRunId ?? null,
    detail: entry.detail ?? null,
  }

  const first = await db.from(T.usageEvents).insert(withExtras)
  if (!first.error) return

  if (isMissingColumnError(first.error)) {
    const fallback = await db.from(T.usageEvents).insert(base)
    if (!fallback.error) return
    throw new Error(`No se pudo registrar el costo: ${describeDbError(fallback.error)}`)
  }

  throw new Error(`No se pudo registrar el costo: ${describeDbError(first.error)}`)
}

/**
 * Arma el costo acumulado de la corrida y lo guarda en
 * `analysis_runs.cost_breakdown`.
 *
 * Camino preferido: sumar desde `usage_events` filtrando por `analysis_run_id`.
 * Ahí ya están **todos** los renglones (los puso `recordCost`), así que
 * `fallbackEntries` se ignora a propósito: sumarlos también sería contar dos
 * veces el mismo gasto.
 *
 * Camino de respaldo (cuando la columna `analysis_run_id` todavía no existe):
 * fusiona `fallbackEntries` sobre lo que ya estaba guardado. Ese camino puede
 * perder renglones si dos trabajos de la misma corrida terminan exactamente al
 * mismo tiempo — ver RIESGOS en el reporte.
 */
export async function runCost(
  analysisRunId: string,
  fallbackEntries: CostEntry[] = [],
): Promise<CostBreakdown> {
  const db = await jobsDb()

  const fromEvents = await db
    .from(T.usageEvents)
    .select('kind, units, unit_label, cost_usd, detail')
    .eq('analysis_run_id', analysisRunId)

  let breakdown: CostBreakdown

  if (!fromEvents.error) {
    const entries: CostEntry[] = (fromEvents.data ?? []).map((row: Record<string, any>) => ({
      category: row.kind as CostCategory,
      units: Number(row.units ?? 0),
      unitLabel: String(row.unit_label ?? ''),
      costUsd: Number(row.cost_usd ?? 0),
      detail: row.detail ?? undefined,
    }))
    // Sin `fallbackEntries`: esos renglones ya vinieron de `usage_events`.
    breakdown = buildBreakdown(entries)
  } else if (isMissingColumnError(fromEvents.error)) {
    const current = await db
      .from(T.analysisRuns)
      .select('cost_breakdown')
      .eq('id', analysisRunId)
      .maybeSingle()

    if (current.error) {
      throw new Error(`No se pudo leer el costo de la corrida: ${describeDbError(current.error)}`)
    }
    const previous = (current.data?.cost_breakdown as CostBreakdown | null)?.entries ?? []
    breakdown = buildBreakdown(mergeEntries(previous, fallbackEntries))
  } else {
    throw new Error(`No se pudo leer el costo de la corrida: ${describeDbError(fromEvents.error)}`)
  }

  const saved = await db
    .from(T.analysisRuns)
    .update({ cost_breakdown: breakdown })
    .eq('id', analysisRunId)

  if (saved.error) {
    throw new Error(`No se pudo guardar el costo de la corrida: ${describeDbError(saved.error)}`)
  }

  return breakdown
}

/* ── Estimación previa ───────────────────────────────────────────────── */

/**
 * ESTIMADO — heurísticas para el presupuesto que ve el usuario antes de gastar.
 * Todos estos números se recalibran con las primeras diez corridas reales; por
 * eso están juntos acá arriba y no desparramados en el código.
 */
export const ESTIMATION = {
  /** El índice mira, como mucho, este número de archivos con el modelo. */
  maxFilesAnalyzed: 150,
  indexInputTokensPerFile: 700,
  indexOutputTokensPerFile: 90,
  checksInputTokensPerFile: 1200,
  checksOutputTokensPerFile: 260,
  /** Redacción del hallazgo en lenguaje llano + prompt de arreglo. */
  findingOutputTokens: 900,
  expectedFindingsPerAudit: 12,
  agentStepsPerTask: 25,
  agentInputTokensPerStep: 2600,
  agentOutputTokensPerStep: 260,
  videoScriptInputTokens: 5000,
  videoScriptOutputTokens: 1400,
  videoSeconds: 75,
  repoStorageGb: 0.05,
  repoRetentionMonths: 1,
} as const

export type EstimateKind = JobKind | 'full_audit'

export interface EstimateParamsByKind {
  ingest_repo: { sizeMb?: number }
  index_code: { files: number }
  run_checks: { files: number }
  run_browser_agent: { tasks: number; stepsPerTask?: number }
  generate_video: { videos: number; secondsPerVideo?: number }
  scan_comments: { files: number }
  build_tutorials: { modules: number; secondsPerVideo?: number }
  full_audit: { files: number; videos?: number; agentTasks?: number }
}

export interface CostEstimate {
  costUsd: number
  entries: CostEntry[]
  /** Unidades concretas: "1 auditoría", "3 videos". Nunca "créditos". */
  unitsPlain: string[]
  /** Línea lista para mostrar: "1 auditoría · 3 videos · US$ 0,42". */
  summaryPlain: string
}

const ESTIMATE_MODEL = 'claude-sonnet-5'

function llmEntry(inputTokens: number, outputTokens: number, detail: string): CostEntry {
  return {
    category: 'llm',
    units: Math.round(inputTokens + outputTokens),
    unitLabel: 'tokens',
    costUsd: llmCostUsd(ESTIMATE_MODEL, { inputTokens, outputTokens }),
    detail,
  }
}

function videoEntries(videos: number, seconds: number): CostEntry[] {
  const characters = Math.round(videos * seconds * NARRATION_CHARS_PER_SECOND)
  return [
    llmEntry(
      videos * ESTIMATION.videoScriptInputTokens,
      videos * ESTIMATION.videoScriptOutputTokens,
      'guion del video',
    ),
    {
      category: 'tts',
      units: characters,
      unitLabel: 'caracteres narrados',
      costUsd: ttsCostUsd(characters),
      detail: 'voz',
    },
    {
      category: 'render',
      units: Math.round(videos * seconds),
      unitLabel: 'segundos de video',
      costUsd: renderCostUsd(videos * seconds),
      detail: 'armado del video',
    },
  ]
}

function finish(entries: CostEntry[], unitsPlain: string[]): CostEstimate {
  const breakdown = buildBreakdown(entries)
  return {
    costUsd: breakdown.totalUsd,
    entries: breakdown.entries,
    unitsPlain,
    summaryPlain: [...unitsPlain, formatUsd(breakdown.totalUsd)].join(' · '),
  }
}

/**
 * Cuánto va a costar, en dólares y en unidades concretas, **antes** de gastarlo.
 * Es requisito de producto: el usuario ve el número antes de apretar el botón.
 */
export function estimate<K extends EstimateKind>(
  kind: K,
  params: EstimateParamsByKind[K],
): CostEstimate {
  switch (kind) {
    case 'ingest_repo': {
      const p = params as EstimateParamsByKind['ingest_repo']
      const gb = p.sizeMb !== undefined ? p.sizeMb / 1024 : ESTIMATION.repoStorageGb
      return finish(
        [
          {
            category: 'storage',
            units: roundUsd(gb),
            unitLabel: 'GB guardados',
            costUsd: storageCostUsd(gb, ESTIMATION.repoRetentionMonths),
            detail: 'copia temporal de tu código',
          },
        ],
        ['1 proyecto'],
      )
    }

    case 'index_code': {
      const p = params as EstimateParamsByKind['index_code']
      const files = Math.min(Math.max(0, p.files), ESTIMATION.maxFilesAnalyzed)
      return finish(
        [
          llmEntry(
            files * ESTIMATION.indexInputTokensPerFile,
            files * ESTIMATION.indexOutputTokensPerFile,
            'lectura del proyecto',
          ),
        ],
        [pluralize(files, 'archivo leído', 'archivos leídos')],
      )
    }

    case 'run_checks': {
      const p = params as EstimateParamsByKind['run_checks']
      const files = Math.min(Math.max(0, p.files), ESTIMATION.maxFilesAnalyzed)
      return finish(
        [
          llmEntry(
            files * ESTIMATION.checksInputTokensPerFile,
            files * ESTIMATION.checksOutputTokensPerFile +
              ESTIMATION.expectedFindingsPerAudit * ESTIMATION.findingOutputTokens,
            'revisión y redacción de hallazgos',
          ),
        ],
        ['1 revisión'],
      )
    }

    case 'run_browser_agent': {
      const p = params as EstimateParamsByKind['run_browser_agent']
      const tasks = Math.max(0, p.tasks)
      const steps = tasks * (p.stepsPerTask ?? ESTIMATION.agentStepsPerTask)
      return finish(
        [
          llmEntry(
            steps * ESTIMATION.agentInputTokensPerStep,
            steps * ESTIMATION.agentOutputTokensPerStep,
            'el agente navegando tu app',
          ),
          {
            category: 'browser_agent',
            units: tasks,
            unitLabel: 'pruebas en tu app',
            // Una sesión de navegador por tarea, más el costo por paso.
            costUsd: roundUsd(
              tasks * BROWSER_SESSION_USD + (browserAgentCostUsd(steps) - BROWSER_SESSION_USD),
            ),
            detail: 'navegador',
          },
        ],
        [pluralize(tasks, 'prueba en tu app', 'pruebas en tu app')],
      )
    }

    case 'generate_video': {
      const p = params as EstimateParamsByKind['generate_video']
      const videos = Math.max(0, p.videos)
      const seconds = p.secondsPerVideo ?? ESTIMATION.videoSeconds
      return finish(videoEntries(videos, seconds), [pluralize(videos, 'video', 'videos')])
    }

    case 'build_tutorials': {
      const p = params as EstimateParamsByKind['build_tutorials']
      const modules = Math.max(0, p.modules)
      const seconds = p.secondsPerVideo ?? ESTIMATION.videoSeconds
      return finish(videoEntries(modules, seconds), [
        pluralize(modules, 'video explicativo', 'videos explicativos'),
      ])
    }

    case 'scan_comments': {
      const p = params as EstimateParamsByKind['scan_comments']
      const files = Math.max(0, p.files)
      // La lectura de comentarios es tree-sitter, no modelo. Solo se consulta al
      // modelo por los casos dudosos: asumimos 5% de los archivos.
      const dudosos = Math.ceil(files * 0.05)
      return finish(
        [llmEntry(dudosos * 500, dudosos * 120, 'comentarios dudosos')],
        [pluralize(files, 'archivo revisado', 'archivos revisados')],
      )
    }

    case 'full_audit': {
      const p = params as EstimateParamsByKind['full_audit']
      const videos = p.videos ?? 3
      const agentTasks = p.agentTasks ?? 4
      const entries = [
        ...estimate('ingest_repo', {}).entries,
        ...estimate('index_code', { files: p.files }).entries,
        ...estimate('run_checks', { files: p.files }).entries,
        ...estimate('scan_comments', { files: p.files }).entries,
        ...estimate('run_browser_agent', { tasks: agentTasks }).entries,
        ...estimate('generate_video', { videos }).entries,
      ]
      return finish(entries, ['1 auditoría', pluralize(videos, 'video', 'videos')])
    }

    default: {
      const exhaustive: never = kind
      throw new Error(`No hay estimación de costo para "${String(exhaustive)}".`)
    }
  }
}

/**
 * Punto de entrada del agente de navegación.
 *
 * `runAgentSession` abre la app desplegada del usuario, intenta un set de tareas
 * reales, graba todo y devuelve un resultado por tarea con su conclusión en lenguaje
 * llano y el video que la prueba.
 *
 * Los casos que NO son errores y se reportan como resultados:
 *  - la app no responde
 *  - la app pide iniciar sesión y no hay cuenta autorizada
 *  - la app está detrás de un muro de pago
 *  - la tarea toca datos de verdad y el usuario todavía no lo autorizó
 * En todos esos casos el resultado dice qué pasó, no "falló".
 *
 * Lo usan: `src/server/jobs/**` (trabajo `run_browser_agent`) y `tests/agent/**`.
 */

import 'server-only'

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Browser } from 'playwright'

import type { AgentSessionResult, AgentTask, AgentTaskId, StackInfo } from '@/lib/types/domain'
import {
  DESKTOP_VIEWPORT,
  launchBrowser,
  openAgentBrowser,
  runMobilePass,
  type AgentBrowser,
  type HorizontalOverflowResult,
} from './browser'
import { CostCapExceededError, CostMeter, type ModelPricing } from './cost'
import { allowedOriginsFor } from './guards'
import { ObservationCollector } from './observations'
import { selectTasks, TASKS_NEEDING_SESSION } from './tasks'
import { TASK_RUNNERS, type TaskContext } from './tasks/index'
import { conclusions } from './tasks/conclusions'
import type {
  AgentProgressListener,
  LlmComplete,
  LlmCompleteJson,
  RecordingManifest,
  TestAccount,
  TestCredentials,
} from './types'

export interface RunAgentSessionOptions {
  /** Dirección pública de la app del usuario. */
  deployedUrl: string
  /** Qué tareas correr. Por defecto, todas las que apliquen al stack. */
  tasks?: AgentTaskId[] | AgentTask[]
  stack?: StackInfo | null
  testCredentials?: TestCredentials
  /** El usuario confirmó en la pantalla que puede tocar datos de verdad. */
  allowDestructive?: boolean
  /** Carpeta de la corrida. Ahí se dejan videos, capturas y el resumen de tiempos. */
  workspaceDir: string
  complete: LlmComplete
  completeJson?: LlmCompleteJson
  onProgress?: AgentProgressListener
  /**
   * Dónde se deposita lo que no entra en `AgentSessionResult`: pedidos de red,
   * cookies y la medición del celular. Sin esto, los chequeos de rastreadores y
   * de pantalla en el teléfono se quedan sin de qué agarrarse.
   */
  collector?: ObservationCollector
  /**
   * Medidor de costo de afuera. Se inyecta cuando quien llama necesita el detalle
   * por renglón —el handler de la cola lo necesita para `reportCost`— en vez de
   * quedarse solo con el total.
   */
  costMeter?: CostMeter

  /* Ajustes con valores razonables por defecto. */
  costCapUsd?: number
  pricing?: Record<string, ModelPricing>
  headless?: boolean
  recordHar?: boolean
  /** Corta los pedidos a dominios de afuera. Se usa en las pruebas. */
  offlineExternal?: boolean
  signal?: AbortSignal
  /** Tiempo máximo por tarea. */
  taskTimeoutMs?: number
}

export async function runAgentSession(options: RunAgentSessionOptions): Promise<AgentSessionResult[]> {
  const {
    deployedUrl,
    workspaceDir,
    complete,
    completeJson,
    onProgress,
    stack = null,
    allowDestructive = false,
    headless = true,
    recordHar = false,
    offlineExternal = false,
    signal,
    taskTimeoutMs = 90_000,
  } = options

  const cost =
    options.costMeter ??
    new CostMeter({
      hardCapUsd: options.costCapUsd ?? 0.5,
      pricing: options.pricing,
      onChange: (totalUsd) => onProgress?.({ kind: 'cost', totalUsd }),
    })
  const collector = options.collector

  const allowedOrigins = allowedOriginsFor(deployedUrl)
  const tasks = resolveTasks(options, stack)
  const accounts = authorizedAccounts(options.testCredentials)

  await mkdir(path.join(workspaceDir, 'agent'), { recursive: true })
  onProgress?.({ kind: 'session_start', totalTasks: tasks.length })

  const results: AgentSessionResult[] = []
  let browser: Browser | null = null
  let capReached = false

  try {
    browser = await launchBrowser(headless)

    const reachable = await preflight(browser, deployedUrl, allowedOrigins, offlineExternal)
    if (!reachable) {
      const blockedResults = tasks.map((task) =>
        emptyResult(task.id, 'blocked', conclusions.appNoResponde(deployedUrl)),
      )
      for (const result of blockedResults) onProgress?.({ kind: 'task_end', taskId: result.taskId, result })
      onProgress?.({ kind: 'session_end', results: blockedResults, totalUsd: cost.totalUsd })
      return blockedResults
    }

    // La pasada a 375 px va una sola vez: no depende de la tarea.
    const mobileOverflow = await safeMobilePass({
      deployedUrl,
      workspaceDir,
      allowedOrigins,
      browser,
      offlineExternal,
    })
    if (mobileOverflow) collector?.agregarDesborde(deployedUrl, mobileOverflow)

    for (const [index, task] of tasks.entries()) {
      if (signal?.aborted) break
      onProgress?.({ kind: 'task_start', taskId: task.id, index, totalTasks: tasks.length })

      if (capReached || cost.isOverCap()) {
        capReached = true
        results.push(emptyResult(task.id, 'skipped', conclusions.seCortoPorCosto()))
        continue
      }

      const skip = shouldSkip(task, { allowDestructive, accounts })
      if (skip) {
        const result = emptyResult(task.id, skip.outcome, skip.conclusionPlain)
        results.push(result)
        onProgress?.({ kind: 'task_end', taskId: task.id, result })
        continue
      }

      const result = await runOneTask({
        task,
        browser,
        deployedUrl,
        workspaceDir,
        allowedOrigins,
        allowDestructive,
        accounts,
        complete,
        completeJson,
        cost,
        signal,
        headless,
        recordHar,
        offlineExternal,
        taskTimeoutMs,
        mobileOverflow,
        onProgress,
        collector,
      })

      results.push(result)
      onProgress?.({ kind: 'task_end', taskId: task.id, result })

      if (cost.isOverCap()) capReached = true
    }
  } finally {
    await browser?.close().catch(() => {})
  }

  onProgress?.({ kind: 'session_end', results, totalUsd: cost.totalUsd })
  return results
}

/* ── Una tarea ───────────────────────────────────────────────────────── */

interface RunOneTaskInput {
  task: AgentTask
  browser: Browser
  deployedUrl: string
  workspaceDir: string
  allowedOrigins: string[]
  allowDestructive: boolean
  accounts: TestAccount[]
  complete: LlmComplete
  completeJson?: LlmCompleteJson
  cost: CostMeter
  signal?: AbortSignal
  headless: boolean
  recordHar: boolean
  offlineExternal: boolean
  taskTimeoutMs: number
  mobileOverflow: HorizontalOverflowResult | null
  onProgress?: AgentProgressListener
  collector?: ObservationCollector
}

async function runOneTask(input: RunOneTaskInput): Promise<AgentSessionResult> {
  const startedAt = Date.now()
  const costBefore = input.cost.totalUsd

  let agentBrowser: AgentBrowser | null = null
  let outcome: AgentSessionResult['outcome'] = 'error'
  let conclusionPlain = conclusions.errorInesperado()

  try {
    agentBrowser = await openAgentBrowser({
      taskId: input.task.id,
      workspaceDir: input.workspaceDir,
      allowedOrigins: input.allowedOrigins,
      headless: input.headless,
      viewport: DESKTOP_VIEWPORT,
      recordHar: input.recordHar,
      offlineExternal: input.offlineExternal,
      browser: input.browser,
    })

    const context: TaskContext = {
      task: input.task,
      browser: agentBrowser,
      deployedUrl: input.deployedUrl,
      allowedOrigins: input.allowedOrigins,
      allowDestructive: input.allowDestructive,
      testAccounts: input.accounts,
      complete: input.complete,
      completeJson: input.completeJson,
      cost: input.cost,
      signal: input.signal,
      mobileOverflow: input.mobileOverflow,
    }

    const runner = TASK_RUNNERS[input.task.id]
    const draft = await withTimeout(runner(context), input.taskTimeoutMs)
    outcome = draft.outcome
    conclusionPlain = draft.conclusionPlain
  } catch (error) {
    if (error instanceof CostCapExceededError) {
      outcome = 'skipped'
      conclusionPlain = conclusions.seCortoPorCosto()
    } else if (isTimeout(error)) {
      outcome = 'blocked'
      conclusionPlain =
        'La prueba tardó demasiado y la corté para no dejar el navegador colgado. ' +
        'Puede ser que tu app haya quedado esperando algo.'
    } else {
      outcome = 'error'
      conclusionPlain = conclusions.errorInesperado()
    }
  }

  const durationMs = Date.now() - startedAt
  input.cost.recordBrowser(durationMs, `agente:${input.task.id}`)

  let manifest: RecordingManifest | null = null
  if (agentBrowser) {
    // El orden importa: las cookies solo se pueden leer con el contexto vivo, y
    // `close()` lo cierra. Después de esta línea ya no hay de dónde sacarlas.
    if (input.collector) await recolectar(input.collector, agentBrowser)
    manifest = await agentBrowser.close().catch(() => null)
    if (manifest) await writeManifest(agentBrowser.taskDir, manifest)
  }

  return {
    taskId: input.task.id,
    outcome,
    conclusionPlain,
    steps: agentBrowser?.steps ?? [],
    recordingPath: manifest?.videoPath ?? undefined,
    durationMs,
    costUsd: Number((input.cost.totalUsd - costBefore).toFixed(6)),
  }
}

/**
 * Deposita en el recolector todo lo que vio esta tarea.
 *
 * Se llama con el navegador todavía abierto: las cookies viven en el contexto y
 * desaparecen al cerrarlo. Si la lectura falla, la sesión aporta igual sus
 * pedidos y sus pantallas — perder las cookies degrada la evidencia, no la corrida.
 */
async function recolectar(collector: ObservationCollector, browser: AgentBrowser): Promise<void> {
  let cookies: Array<{ name: string; domain: string }> = []
  try {
    cookies = (await browser.context.cookies()).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
    }))
  } catch {
    // El contexto ya estaba cerrado (la tarea se cayó a mitad de camino). Se sigue
    // sin cookies: el resto de lo observado en esta tarea vale igual.
  }

  collector.agregarSesion({
    taskId: browser.taskId,
    requests: browser.requests,
    pages: browser.pages,
    steps: browser.steps,
    cookies,
    cookiesAtMs: browser.atMs(),
  })
}

/**
 * Resumen de tiempos junto al video.
 * Es el contrato con el frente de video: con `atMs` de cada paso y el arranque de la
 * grabación se recorta el segundo exacto del clip sin volver a correr nada.
 */
async function writeManifest(taskDir: string, manifest: RecordingManifest): Promise<void> {
  await writeFile(path.join(taskDir, 'recording.json'), JSON.stringify(manifest, null, 2), 'utf8').catch(
    () => {},
  )
}

/* ── Decisiones previas ──────────────────────────────────────────────── */

function resolveTasks(options: RunAgentSessionOptions, stack: StackInfo | null): AgentTask[] {
  if (Array.isArray(options.tasks) && options.tasks.length > 0 && typeof options.tasks[0] === 'object') {
    return options.tasks as AgentTask[]
  }
  const ids = options.tasks as AgentTaskId[] | undefined
  return selectTasks(stack, ids)
}

/** Solo se usan cuentas que el usuario confirmó (DECISIONS.md D9). */
function authorizedAccounts(credentials?: TestCredentials): TestAccount[] {
  if (!credentials) return []
  if (!credentials.createdWithPermission) return []
  return credentials.accounts ?? []
}

function shouldSkip(
  task: AgentTask,
  input: { allowDestructive: boolean; accounts: TestAccount[] },
): { outcome: AgentSessionResult['outcome']; conclusionPlain: string } | null {
  if (task.destructive && !input.allowDestructive) {
    return {
      outcome: 'skipped',
      conclusionPlain: conclusions.sinPermiso(describeTask(task.id)),
    }
  }
  if (TASKS_NEEDING_SESSION.includes(task.id) && input.accounts.length === 0) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }
  if (task.id === 'cross_tenant_read' && input.accounts.length < 2) {
    return { outcome: 'blocked', conclusionPlain: conclusions.crossTenantSinDatos() }
  }
  return null
}

function describeTask(taskId: AgentTaskId): string {
  switch (taskId) {
    case 'signup':
      return 'crear una cuenta'
    case 'edit_profile':
      return 'cambiar datos del perfil'
    case 'delete_account':
      return 'buscar cómo borrar la cuenta'
    default:
      return 'esa prueba'
  }
}

function emptyResult(
  taskId: AgentTaskId,
  outcome: AgentSessionResult['outcome'],
  conclusionPlain: string,
): AgentSessionResult {
  return { taskId, outcome, conclusionPlain, steps: [], durationMs: 0, costUsd: 0 }
}

/* ── Preflight y utilidades ──────────────────────────────────────────── */

/** ¿La app responde? Si no, no tiene sentido gastar en el resto. */
async function preflight(
  browser: Browser,
  deployedUrl: string,
  allowedOrigins: string[],
  offlineExternal: boolean,
): Promise<boolean> {
  if (allowedOrigins.length === 0) return false
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    if (offlineExternal) {
      await context.route('**/*', async (route) => {
        let origin = ''
        try {
          origin = new URL(route.request().url()).origin
        } catch {
          /* sin origen */
        }
        if (origin && !allowedOrigins.includes(origin)) {
          await route.abort('blockedbyclient').catch(() => {})
          return
        }
        await route.continue().catch(() => {})
      })
    }
    const page = await context.newPage()
    const response = await page.goto(deployedUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    return (response?.status() ?? 0) < 500
  } catch {
    return false
  } finally {
    await context.close().catch(() => {})
  }
}

async function safeMobilePass(input: {
  deployedUrl: string
  workspaceDir: string
  allowedOrigins: string[]
  browser: Browser
  offlineExternal: boolean
}): Promise<HorizontalOverflowResult | null> {
  try {
    return await runMobilePass(input.deployedUrl, {
      workspaceDir: input.workspaceDir,
      allowedOrigins: input.allowedOrigins,
      browser: input.browser,
      offlineExternal: input.offlineExternal,
    })
  } catch {
    return null
  }
}

class TaskTimeoutError extends Error {
  constructor(ms: number) {
    super(`La tarea superó el tiempo máximo de ${ms} ms.`)
    this.name = 'TaskTimeoutError'
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof TaskTimeoutError
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TaskTimeoutError(ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

/* ── Reexportes para los otros frentes ───────────────────────────────── */

export { ALL_TASKS, TASK_ORDER, selectTasks, getTask } from './tasks'
export { CostMeter, CostCapExceededError, DEFAULT_PRICING } from './cost'
export { allowedOriginsFor } from './guards'
export { runMobilePass, detectHorizontalOverflow, CLOCK_TOLERANCE_MS } from './browser'
export { REDACTION_NOTES, redactUrl } from './redact'
export { ObservationCollector, SESION_TELEFONO, type AgentObservations } from './observations'
export type { RunAgentSessionOptions as AgentSessionOptions }
export type {
  AgentProgressEvent,
  AgentProgressListener,
  LlmComplete,
  LlmCompleteJson,
  RecordingManifest,
  TestAccount,
  TestCredentials,
} from './types'

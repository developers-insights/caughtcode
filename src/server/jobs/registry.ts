/**
 * Registro de handlers: acá cada frente engancha el código que ejecuta su tipo
 * de trabajo.
 *
 * Arranca con un stub por cada `JobKind` que tira un error claro. Así el worker
 * levanta desde el día uno sin romperse, y cuando el frente dueño está listo
 * solo llama a `registerHandler('run_checks', ...)` y reemplaza el stub.
 *
 * ## Idempotencia: la regla para todos los handlers
 *
 * Un handler **puede correr dos veces** (el worker se murió después de escribir
 * pero antes de marcar el trabajo como terminado). Entonces:
 *
 *   1. Las etapas caras van dentro de `runStages()`: lo que ya terminó no se
 *      vuelve a hacer al reintentar.
 *   2. Toda escritura es **borrar-y-escribir por clave natural**, nunca "append
 *      a ciegas". Concretamente:
 *      - `ingest_repo` → escribe en storage en una ruta derivada de
 *        `analysis_run_id` (sobreescribe) y actualiza `projects.storage_path`.
 *      - `index_code` → borra `code_index` de ese `analysis_run_id` y reinserta.
 *      - `run_checks` → por cada `check_id`, borra `findings` de
 *        (`analysis_run_id`, `check_id`) y reinserta.
 *      - `run_browser_agent` → borra `agent_sessions` de
 *        (`analysis_run_id`, `task_id`) y reinserta.
 *      - `generate_video` → actualiza la fila de `videos` por id; si crea, borra
 *        primero las de (`finding_id`, `kind`).
 *      - `scan_comments` → borra `comment_scans` de
 *        (`project_id`, `analysis_run_id`) y reinserta.
 *      - `build_tutorials` → borra `videos` de (`analysis_run_id`, `module_id`)
 *        y reinserta.
 *   3. Nada de efectos externos no idempotentes (mandar mails, cobrar) sin una
 *      clave de idempotencia propia.
 */

import type { CostEntry, JobKind } from '@/lib/types/domain'
import { HandlerNotRegisteredError } from './errors'

/* ── Catálogo de tipos de trabajo ─────────────────────────────────────── */

/**
 * El `Record<JobKind, string>` obliga al compilador a avisar si alguien agrega
 * un `JobKind` nuevo en `domain.ts` y se olvida de este archivo.
 * Los textos son los que ve el usuario: cero jerga.
 */
export const JOB_KIND_LABEL: Record<JobKind, string> = {
  ingest_repo: 'Trayendo tu código',
  index_code: 'Entendiendo cómo está armado tu proyecto',
  run_checks: 'Revisando tu proyecto',
  run_browser_agent: 'Probando tu app como si fuera un usuario',
  generate_video: 'Armando el video',
  scan_comments: 'Revisando los comentarios del código',
  build_tutorials: 'Armando los videos de "cómo funciona mi proyecto"',
}

export const JOB_KINDS = Object.keys(JOB_KIND_LABEL) as JobKind[]

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && value in JOB_KIND_LABEL
}

/* ── Contexto que recibe cada handler ────────────────────────────────── */

export interface JobContext {
  jobId: string
  orgId: string
  projectId: string | null
  analysisRunId: string | null
  /** Número de intento en curso, empezando en 1. */
  attempt: number
  maxAttempts: number
  /**
   * Se dispara cuando el worker se está apagando. Los handlers largos deberían
   * mirarlo entre etapas y cortar prolijo.
   */
  signal: AbortSignal
  /**
   * Renueva el lease y publica avance. `progress` es 0–100 y describe el
   * trabajo entero, no la etapa.
   */
  heartbeat(stage?: string, progress?: number): Promise<void>
  /** Log con prefijo del trabajo. Va a la consola del worker. */
  log(message: string): void
  /** Registra cuánto costó una operación. Se acumula en la corrida. */
  reportCost(entry: CostEntry): Promise<void>
}

export type JobHandler<TPayload = any> = (payload: TPayload, ctx: JobContext) => Promise<void>

/** Azúcar para que el handler quede tipado en el archivo del frente dueño. */
export function defineHandler<TPayload>(handler: JobHandler<TPayload>): JobHandler<TPayload> {
  return handler
}

/* ── Registro ────────────────────────────────────────────────────────── */

interface RegistryEntry {
  handler: JobHandler
  isStub: boolean
}

function stubFor(kind: JobKind): RegistryEntry {
  return {
    isStub: true,
    handler: async () => {
      throw new HandlerNotRegisteredError(kind)
    },
  }
}

const registry = new Map<JobKind, RegistryEntry>(
  JOB_KINDS.map((kind) => [kind, stubFor(kind)] as const),
)

/** Engancha el handler real de un tipo de trabajo. Reemplaza el stub. */
export function registerHandler<TPayload = any>(
  kind: JobKind,
  handler: JobHandler<TPayload>,
): void {
  registry.set(kind, { handler: handler as JobHandler, isStub: false })
}

export function getHandler(kind: JobKind): JobHandler {
  const entry = registry.get(kind)
  if (!entry) {
    // Un `kind` que llegó de la base pero no existe en el código.
    return async () => {
      throw new HandlerNotRegisteredError(kind)
    }
  }
  return entry.handler
}

/** `true` si ya hay código de verdad (no el stub) para ese tipo. */
export function hasRealHandler(kind: JobKind): boolean {
  return registry.get(kind)?.isStub === false
}

export function registeredKinds(): JobKind[] {
  return JOB_KINDS.filter(hasRealHandler)
}

export function pendingKinds(): JobKind[] {
  return JOB_KINDS.filter((kind) => !hasRealHandler(kind))
}

/** Solo para tests: vuelve todo a stubs. */
export function resetHandlers(): void {
  for (const kind of JOB_KINDS) registry.set(kind, stubFor(kind))
}

/**
 * Tipos internos del agente de navegación.
 *
 * Los tipos de dominio (`AgentTask`, `AgentStep`, `AgentSessionResult`, …) viven en
 * `@/lib/types/domain` y NO se redefinen acá. Esto es solo el andamiaje que el agente
 * necesita puertas adentro: el puente al modelo, las cuentas de prueba y el progreso.
 *
 * Lo usan: `src/server/agent/**` y `tests/agent/**`.
 */

import 'server-only'

import type { AgentSessionResult, AgentStep, AgentTaskId } from '@/lib/types/domain'

/* ── Puente al modelo ─────────────────────────────────────────────────── */

/**
 * Consumo de una llamada al modelo. Si el frente que provee `complete` lo informa,
 * el costo es real; si no, el agente lo estima (ver `cost.ts`).
 */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  /** Costo ya calculado por quien llamó al modelo. Tiene prioridad sobre la estimación. */
  costUsd?: number
  model?: string
}

export interface LlmCallOptions {
  /** Etiqueta corta para el registro de costos, ej. "decidir-paso". */
  purpose?: string
  maxTokens?: number
  signal?: AbortSignal
}

/** Texto pelado, o texto + consumo. Ambas formas son válidas. */
export type LlmTextResult = string | { text: string; usage?: LlmUsage }

export type LlmComplete = (prompt: string, options?: LlmCallOptions) => Promise<LlmTextResult>

export interface LlmJsonResult {
  json: unknown
  usage?: LlmUsage
}

/**
 * Opcional. Si no se provee, el agente pide JSON por `complete` y lo extrae del texto.
 * El esquema siempre se valida de nuestro lado con `zod`: nunca confiamos en el modelo.
 */
export type LlmCompleteJson = (prompt: string, options?: LlmCallOptions) => Promise<LlmJsonResult>

/** Normaliza las dos formas de respuesta de texto. */
export function readTextResult(result: LlmTextResult): { text: string; usage?: LlmUsage } {
  if (typeof result === 'string') return { text: result }
  return { text: result.text ?? '', usage: result.usage }
}

/* ── Cuentas de prueba ───────────────────────────────────────────────── */

/**
 * Cuenta que el agente puede usar para entrar a la app.
 * Nunca son credenciales reales del usuario: son cuentas creadas para la auditoría (D9).
 */
export interface TestAccount {
  /** "a" es la cuenta principal; "b" existe solo para el chequeo de datos cruzados. */
  label: 'a' | 'b'
  email: string
  password: string
  /**
   * Direcciones de recursos que le pertenecen a esta cuenta (facturas, pedidos, perfiles).
   * Con esto se arma el intento de entrar a lo ajeno cambiando el número de la dirección.
   */
  resourceUrls?: string[]
}

export interface TestCredentials {
  accounts: TestAccount[]
  /**
   * El usuario confirmó explícitamente la creación de estas cuentas.
   * Si es `false`, el agente NO las usa y las tareas que necesitan sesión quedan bloqueadas.
   */
  createdWithPermission: boolean
}

/* ── Progreso ────────────────────────────────────────────────────────── */

export type AgentProgressEvent =
  | { kind: 'session_start'; totalTasks: number }
  | { kind: 'task_start'; taskId: AgentTaskId; index: number; totalTasks: number }
  | { kind: 'step'; taskId: AgentTaskId; step: AgentStep }
  | { kind: 'task_end'; taskId: AgentTaskId; result: AgentSessionResult }
  | { kind: 'cost'; totalUsd: number }
  | { kind: 'session_end'; results: AgentSessionResult[]; totalUsd: number }

export type AgentProgressListener = (event: AgentProgressEvent) => void

/* ── Acciones que el modelo puede pedir ──────────────────────────────── */

export type AgentActionKind =
  | 'click'
  | 'fill'
  | 'press'
  | 'goto'
  | 'scroll'
  | 'done'
  | 'give_up'

export interface AgentAction {
  action: AgentActionKind
  /** Normalmente `ref=e12`, tomado del árbol de la página. También acepta CSS o `role=…`. */
  selector?: string
  value?: string
  /** Por qué el modelo eligió esto. Va al detalle del paso y ayuda a auditar la corrida. */
  why: string
}

/** Resumen de lo que dejó una corrida en disco, para que el frente de video recorte el clip. */
export interface RecordingManifest {
  taskId: AgentTaskId
  videoPath: string | null
  harPath: string | null
  /** Reloj de pared del momento en que arrancó la grabación. */
  videoStartedAtEpochMs: number
  finishedAtEpochMs: number
  /** Duración medida con el reloj de pared. La del archivo puede diferir unos pocos cuadros. */
  wallDurationMs: number
  /**
   * Margen con el que hay que recortar. `atMs` no cae exactamente sobre el cuadro del
   * video: hay unos cientos de milisegundos de juego entre que el navegador dibuja, el
   * screencast codifica y nosotros anotamos. Cortar `[atMs - margen, atMs + margen]`.
   */
  clockToleranceMs: number
  viewport: { width: number; height: number }
  steps: Array<Pick<AgentStep, 'index' | 'atMs' | 'action' | 'url' | 'note' | 'screenshotPath'>>
}

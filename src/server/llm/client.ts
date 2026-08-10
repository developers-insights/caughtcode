/**
 * Wrapper del SDK de Anthropic.
 *
 * Regla del wrapper: **toda llamada al modelo registra lo que costó.** No hay
 * una variante "rápida" sin medición, porque sin medición no se puede fijar
 * precio ni detectar que un cambio duplicó el gasto.
 *
 * Uso típico desde un handler de la cola:
 *
 * ```ts
 * const { text } = await complete({
 *   system: 'Sos ...',
 *   messages: [{ role: 'user', content: '...' }],
 *   reportCost: ctx.reportCost,
 *   detail: 'redacción del hallazgo',
 * })
 * ```
 */

import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import type { CostEntry } from '@/lib/types/domain'
import { optionalEnv } from '@/lib/env'
import { JobError } from '@/server/jobs/errors'
import { llmCostUsd, totalBilledTokens, type LlmUsage } from '@/server/cost/pricing'

export const DEFAULT_MAX_TOKENS = 4096

/** Arriba de esto conviene streaming o el request se corta por timeout HTTP. */
const STREAMING_THRESHOLD_TOKENS = 16_000

let cached: Anthropic | null = null

export function getAnthropic(): Anthropic {
  if (cached) return cached
  const apiKey = optionalEnv('ANTHROPIC_API_KEY')
  if (!apiKey) {
    throw new JobError(
      'Falta la clave de Anthropic (ANTHROPIC_API_KEY). Sin esa clave no se puede analizar ' +
        'ni redactar nada. Completala en .env.local (mirá .env.example) y volvé a intentar.',
      { retryable: false, code: 'falta_anthropic_api_key' },
    )
  }
  cached = new Anthropic({ apiKey })
  return cached
}

/** Solo para tests. */
export function setAnthropicClient(client: Anthropic | null): void {
  cached = client
}

export function defaultModel(): string {
  return optionalEnv('ANTHROPIC_MODEL') ?? 'claude-sonnet-5'
}

/* ── Tipos ───────────────────────────────────────────────────────────── */

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompleteOptions {
  system?: string
  messages: LlmMessage[]
  maxTokens?: number
  model?: string
  /**
   * `disabled` (default) para extracción y tareas mecánicas: más barato y sin
   * sorpresas de truncado. `adaptive` cuando la calidad del razonamiento importa.
   */
  thinking?: 'disabled' | 'adaptive'
  /** Se llama con el renglón de costo. Pasale `ctx.reportCost` desde un handler. */
  reportCost?: (entry: CostEntry) => void | Promise<void>
  /** Texto corto para el libro de costos: "guion del video", "hallazgo", etc. */
  detail?: string
  signal?: AbortSignal
}

export interface CompleteResult {
  text: string
  model: string
  usage: LlmUsage
  costUsd: number
  /** `true` si se cortó por `max_tokens`: la respuesta está incompleta. */
  truncated: boolean
}

/* ── Llamada base ────────────────────────────────────────────────────── */

export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  if (options.messages.length === 0) {
    throw new JobError('No se puede llamar al modelo sin mensajes.', { retryable: false })
  }

  const client = getAnthropic()
  const model = options.model ?? defaultModel()
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages: options.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    thinking: options.thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' },
    ...(options.system ? { system: options.system } : {}),
  }

  let message: Anthropic.Message
  try {
    if (maxTokens > STREAMING_THRESHOLD_TOKENS) {
      const stream = client.messages.stream(params, { signal: options.signal })
      message = await stream.finalMessage()
    } else {
      message = await client.messages.create(params, { signal: options.signal })
    }
  } catch (error) {
    throw toJobError(error)
  }

  if (message.stop_reason === 'refusal') {
    throw new JobError(
      'El modelo se negó a responder este pedido. Si creés que es un error, contanos qué ' +
        'estabas analizando.',
      { retryable: false, code: 'modelo_rechazo' },
    )
  }

  const usage: LlmUsage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
  }
  const costUsd = llmCostUsd(model, usage)

  if (options.reportCost) {
    await options.reportCost({
      category: 'llm',
      units: totalBilledTokens(usage),
      unitLabel: 'tokens',
      costUsd,
      detail: options.detail ?? model,
    })
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()

  return {
    text,
    model,
    usage,
    costUsd,
    truncated: message.stop_reason === 'max_tokens',
  }
}

/* ── Salida JSON validada ────────────────────────────────────────────── */

export interface CompleteJsonOptions<T> extends CompleteOptions {
  schema: z.ZodType<T>
  /** Qué se espera, en una línea. Se le pasa al modelo para orientarlo. */
  shapeHint?: string
}

export interface CompleteJsonResult<T> extends CompleteResult {
  data: T
  /** `true` si hizo falta el reintento correctivo. */
  retried: boolean
}

const JSON_INSTRUCTION =
  'Respondé únicamente con un objeto JSON válido. Sin texto antes ni después, ' +
  'sin bloques de código, sin comentarios.'

/**
 * Igual que `complete`, pero valida la salida con el schema de zod.
 * Si el JSON no valida, reintenta **una vez** mostrándole al modelo qué falló.
 */
export async function completeJson<T>(
  options: CompleteJsonOptions<T>,
): Promise<CompleteJsonResult<T>> {
  const system = [options.system, JSON_INSTRUCTION, options.shapeHint]
    .filter(Boolean)
    .join('\n\n')

  const first = await complete({ ...options, system })
  const parsedFirst = parseAndValidate(first.text, options.schema)
  if (parsedFirst.ok) {
    return { ...first, data: parsedFirst.data, retried: false }
  }

  const second = await complete({
    ...options,
    system,
    messages: [
      ...options.messages,
      { role: 'assistant', content: first.text.slice(0, 4000) },
      {
        role: 'user',
        content:
          `Ese JSON no sirve: ${parsedFirst.problem}\n\n` +
          'Devolvé de nuevo el JSON completo, corregido. Solo el JSON.',
      },
    ],
  })

  const parsedSecond = parseAndValidate(second.text, options.schema)
  if (!parsedSecond.ok) {
    throw new JobError(
      `El modelo no devolvió un resultado con la forma esperada (${parsedSecond.problem}).`,
      { retryable: true, code: 'json_invalido' },
    )
  }

  const usage: LlmUsage = {
    inputTokens: first.usage.inputTokens + second.usage.inputTokens,
    outputTokens: first.usage.outputTokens + second.usage.outputTokens,
    cacheCreationInputTokens:
      (first.usage.cacheCreationInputTokens ?? 0) + (second.usage.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens:
      (first.usage.cacheReadInputTokens ?? 0) + (second.usage.cacheReadInputTokens ?? 0),
  }

  return {
    ...second,
    usage,
    costUsd: Math.round((first.costUsd + second.costUsd) * 1_000_000) / 1_000_000,
    data: parsedSecond.data,
    retried: true,
  }
}

type ParseOutcome<T> = { ok: true; data: T } | { ok: false; problem: string }

function parseAndValidate<T>(text: string, schema: z.ZodType<T>): ParseOutcome<T> {
  const raw = extractJson(text)
  if (raw === null) return { ok: false, problem: 'no se encontró ningún objeto JSON en la respuesta' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, problem: `no es JSON válido (${(error as Error).message})` }
  }

  const result = schema.safeParse(parsed)
  if (result.success) return { ok: true, data: result.data }

  const problems = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'raíz'}: ${issue.message}`)
    .join('; ')
  return { ok: false, problem: problems || 'no coincide con la forma esperada' }
}

/** Saca el JSON aunque venga envuelto en ```json o con texto alrededor. */
export function extractJson(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : trimmed).trim()

  const firstObject = candidate.indexOf('{')
  const firstArray = candidate.indexOf('[')
  const start =
    firstObject === -1 ? firstArray : firstArray === -1 ? firstObject : Math.min(firstObject, firstArray)
  if (start === -1) return null

  const closing = candidate[start] === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(closing)
  if (end <= start) return null

  return candidate.slice(start, end + 1)
}

/* ── Errores ─────────────────────────────────────────────────────────── */

function toJobError(error: unknown): JobError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new JobError(
      'La clave de Anthropic no es válida. Revisá ANTHROPIC_API_KEY en .env.local.',
      { retryable: false, code: 'anthropic_auth', cause: error },
    )
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new JobError('La clave de Anthropic no tiene permiso para usar este modelo.', {
      retryable: false,
      code: 'anthropic_permiso',
      cause: error,
    })
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new JobError(`El pedido al modelo era inválido: ${error.message}`, {
      retryable: false,
      code: 'anthropic_pedido_invalido',
      cause: error,
    })
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new JobError('Nos pasamos del límite de uso del modelo. Se reintenta en un rato.', {
      retryable: true,
      code: 'anthropic_limite',
      cause: error,
    })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new JobError('No se pudo conectar con el modelo. Se reintenta.', {
      retryable: true,
      code: 'anthropic_conexion',
      cause: error,
    })
  }
  if (error instanceof Anthropic.APIError) {
    return new JobError(`El modelo devolvió un error (${error.status}): ${error.message}`, {
      retryable: true,
      code: 'anthropic_error',
      cause: error,
    })
  }
  if (error instanceof Error) {
    return new JobError(error.message, { retryable: true, cause: error })
  }
  return new JobError('Error desconocido al hablar con el modelo.', { retryable: true })
}

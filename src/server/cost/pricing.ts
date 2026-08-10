/**
 * Tabla de precios. **Un solo lugar.**
 *
 * Sin esto no se puede fijar un precio de venta ni detectar una regresión de
 * costos, así que cada número lleva fuente y fecha. Los que dicen `ESTIMADO`
 * todavía no se midieron contra una factura real: sirven para mostrar un
 * "esto te va a costar más o menos", no para cerrar un margen.
 *
 * Módulo puro: sin red, sin base de datos, testeable solo.
 */

/* ── Modelos de lenguaje ─────────────────────────────────────────────── */

export interface ModelPrice {
  /** Dólares por millón de tokens de entrada. */
  inputPerMTok: number
  /** Dólares por millón de tokens de salida (incluye los de razonamiento). */
  outputPerMTok: number
}

/**
 * Fuente: tabla de precios de la API de Anthropic. Fecha de corte: 2026-06-24.
 * Nota: `claude-sonnet-5` tiene precio promocional 2 / 10 hasta 2026-08-31.
 * Acá usamos el precio de lista (3 / 15) a propósito: preferimos sobreestimar
 * el costo antes que prometerle al usuario un número que después sube.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
}

/** Si aparece un modelo que no está en la tabla, cobramos como el más caro que usamos. */
export const FALLBACK_MODEL_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 }

/** Multiplicadores de caché de prompt. Fuente: docs de prompt caching, 2026-06-24. */
export const CACHE_WRITE_MULTIPLIER = 1.25
export const CACHE_READ_MULTIPLIER = 0.1

export function priceForModel(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? FALLBACK_MODEL_PRICE
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

/** Cuánto costó una llamada al modelo, en dólares. */
export function llmCostUsd(model: string, usage: LlmUsage): number {
  const price = priceForModel(model)
  const perInputToken = price.inputPerMTok / 1_000_000
  const perOutputToken = price.outputPerMTok / 1_000_000

  const input = Math.max(0, usage.inputTokens) * perInputToken
  const output = Math.max(0, usage.outputTokens) * perOutputToken
  const cacheWrite =
    Math.max(0, usage.cacheCreationInputTokens ?? 0) * perInputToken * CACHE_WRITE_MULTIPLIER
  const cacheRead =
    Math.max(0, usage.cacheReadInputTokens ?? 0) * perInputToken * CACHE_READ_MULTIPLIER

  return roundUsd(input + output + cacheWrite + cacheRead)
}

/** Todos los tokens que se facturan en una llamada (para mostrar unidades). */
export function totalBilledTokens(usage: LlmUsage): number {
  return (
    Math.max(0, usage.inputTokens) +
    Math.max(0, usage.outputTokens) +
    Math.max(0, usage.cacheCreationInputTokens ?? 0) +
    Math.max(0, usage.cacheReadInputTokens ?? 0)
  )
}

/* ── Voz (TTS) ───────────────────────────────────────────────────────── */

export type TtsProvider = 'azure' | 'azure_hd' | 'google' | 'none'

/**
 * ESTIMADO — falta contrastar contra factura real.
 * Referencias públicas a 2026-08: Azure Neural ≈ US$16 por millón de caracteres,
 * Azure Neural HD ≈ US$30, Google Chirp3-HD ≈ US$30. ElevenLabs queda afuera
 * a propósito (ver DECISIONS.md).
 */
export const TTS_USD_PER_MCHAR: Record<TtsProvider, number> = {
  azure: 16,
  azure_hd: 30,
  google: 30,
  none: 0,
}

export function ttsCostUsd(characters: number, provider: TtsProvider = 'azure'): number {
  const perChar = (TTS_USD_PER_MCHAR[provider] ?? 0) / 1_000_000
  return roundUsd(Math.max(0, characters) * perChar)
}

/** Caracteres de narración por segundo de video. ESTIMADO sobre locución en es-AR. */
export const NARRATION_CHARS_PER_SECOND = 15

/* ── Agente de navegación ────────────────────────────────────────────── */

/**
 * ESTIMADO — costo de infraestructura del navegador por corrida, sin contar los
 * tokens del modelo (esos se registran aparte con `llmCostUsd`).
 */
export const BROWSER_SESSION_USD = 0.02
export const BROWSER_STEP_USD = 0.001

export function browserAgentCostUsd(steps: number): number {
  return roundUsd(BROWSER_SESSION_USD + Math.max(0, steps) * BROWSER_STEP_USD)
}

/* ── Render de video ─────────────────────────────────────────────────── */

/** ESTIMADO — minuto de CPU de render. Se recalibra cuando midamos 5–10 renders. */
export const RENDER_USD_PER_COMPUTE_MINUTE = 0.05
/** ESTIMADO — cuántos minutos de CPU cuesta cada segundo de video final. */
export const RENDER_COMPUTE_MINUTES_PER_VIDEO_SECOND = 0.019

export function renderCostUsd(videoSeconds: number): number {
  const computeMinutes =
    Math.max(0, videoSeconds) * RENDER_COMPUTE_MINUTES_PER_VIDEO_SECOND
  return roundUsd(computeMinutes * RENDER_USD_PER_COMPUTE_MINUTE)
}

/* ── Almacenamiento ──────────────────────────────────────────────────── */

/** ESTIMADO — Supabase Storage, US$/GB/mes. */
export const STORAGE_USD_PER_GB_MONTH = 0.021

export function storageCostUsd(gigabytes: number, months = 1): number {
  return roundUsd(Math.max(0, gigabytes) * months * STORAGE_USD_PER_GB_MONTH)
}

/* ── Utilidades ──────────────────────────────────────────────────────── */

/** Redondeo a 6 decimales: suficiente para no perder fracciones de centavo. */
export function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * Formato para mostrarle al usuario. Nunca decimos "créditos": decimos plata.
 * Menos de un centavo se dice así, no como "US$ 0,00".
 */
export function formatUsd(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  if (safe > 0 && safe < 0.005) return 'menos de US$ 0,01'
  return `US$ ${safe.toFixed(2).replace('.', ',')}`
}

/** "3 videos", "1 video". Para las unidades concretas del presupuesto. */
export function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

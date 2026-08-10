/**
 * Backoff exponencial para reintentos de trabajos.
 *
 * Módulo puro a propósito: no toca red ni base de datos, así se puede testear solo
 * y se puede importar desde el worker standalone sin arrastrar nada de Next.
 *
 * Fórmula acordada: `run_after = ahora + min(2^intentos * 30s, 15min)`.
 */

/** Primer reintento: 30 segundos. */
export const BASE_BACKOFF_MS = 30_000

/** Techo: 15 minutos. Más que esto es un trabajo que nadie va a estar esperando. */
export const MAX_BACKOFF_MS = 15 * 60_000

/** Evita `2 ** 5000` = Infinity si alguna vez llega un `attempts` absurdo. */
const MAX_EXPONENT = 20

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  /**
   * Ruido aleatorio para que N workers que fallaron juntos no reintenten
   * exactamente al mismo tiempo. `0` = determinístico (lo que usan los tests).
   * `0.2` = hasta ±20% de variación.
   */
  jitterRatio?: number
  /** Inyectable para poder testear el jitter. */
  random?: () => number
}

/** Cuántos milisegundos esperar antes del próximo intento. */
export function computeBackoffMs(attempts: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? BASE_BACKOFF_MS
  const maxMs = options.maxMs ?? MAX_BACKOFF_MS

  const safeAttempts = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0
  const exponent = Math.min(safeAttempts, MAX_EXPONENT)
  const base = Math.min(baseMs * 2 ** exponent, maxMs)

  const jitterRatio = options.jitterRatio ?? 0
  if (jitterRatio <= 0) return base

  const random = options.random ?? Math.random
  const delta = base * jitterRatio * (random() * 2 - 1)
  return Math.max(0, Math.min(maxMs, Math.round(base + delta)))
}

/** Timestamp ISO en el que el trabajo vuelve a estar disponible. */
export function nextRunAfter(
  attempts: number,
  options: BackoffOptions = {},
  now: Date = new Date(),
): string {
  return new Date(now.getTime() + computeBackoffMs(attempts, options)).toISOString()
}

/** ¿Este intento fue el último que le quedaba al trabajo? */
export function isLastAttempt(attempts: number, maxAttempts: number): boolean {
  return attempts >= Math.max(1, maxAttempts)
}

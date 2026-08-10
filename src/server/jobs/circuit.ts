/**
 * Freno para el worker cuando las cosas fallan de una forma que reintentar no arregla.
 *
 * ## Por qué existe
 *
 * El backoff de `backoff.ts` protege al *trabajo*: si un handler revienta, el
 * trabajo vuelve a la cola más tarde. Pero no protege al *worker*: si lo que
 * falla es más abajo — el claim devuelve basura, la base rechaza el update, la
 * conexión está rota — el trabajo nunca llega a registrarse como fallido y el
 * loop vuelve a empezar sin esperar nada.
 *
 * Eso ya pasó: ~2 intentos por segundo, indefinidamente, con la cola vacía y sin
 * que nada avanzara. Un worker que no puede ni anotar que falló tiene que
 * quedarse quieto, no golpear más fuerte.
 *
 * Módulo puro a propósito: sin red, sin base, sin timers. El worker decide qué
 * hacer con el número que devuelve.
 */

export interface FrenoOptions {
  /** Cuántas fallas seguidas se toleran antes de empezar a esperar. */
  tolerancia?: number
  /** Espera de la primera falla ya pasada la tolerancia. */
  baseMs?: number
  /** Techo de la espera. */
  maxMs?: number
}

export const FRENO_TOLERANCIA = 3
export const FRENO_BASE_MS = 2_000
export const FRENO_MAX_MS = 60_000

/** Evita `2 ** 5000` = Infinity si el contador se dispara. */
const MAX_EXPONENTE = 20

export class FrenoDeFallas {
  /** Fallas inesperadas seguidas. Se reinicia con el primer éxito. */
  seguidas = 0

  private readonly tolerancia: number
  private readonly baseMs: number
  private readonly maxMs: number
  private avisado = false

  constructor(options: FrenoOptions = {}) {
    this.tolerancia = Math.max(1, options.tolerancia ?? FRENO_TOLERANCIA)
    this.baseMs = Math.max(0, options.baseMs ?? FRENO_BASE_MS)
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? FRENO_MAX_MS)
  }

  /** Un trabajo terminó (bien o mal, pero el sistema funcionó). Suelta el freno. */
  exito(): void {
    this.seguidas = 0
    this.avisado = false
  }

  /** Un trabajo reventó de una forma que el runner no pudo manejar. */
  falla(): void {
    this.seguidas += 1
  }

  /** Cuánto esperar antes de volver a mirar la cola. `0` = seguir normal. */
  esperaMs(): number {
    if (this.seguidas < this.tolerancia) return 0
    const exponente = Math.min(this.seguidas - this.tolerancia, MAX_EXPONENTE)
    return Math.min(this.maxMs, this.baseMs * 2 ** exponente)
  }

  /**
   * `true` una sola vez por tanda de fallas. Un worker frenado no tiene que
   * escribir la misma línea de log cada dos segundos: eso es el mismo ruido que
   * estamos tratando de evitar.
   */
  debeAvisar(): boolean {
    if (this.esperaMs() === 0 || this.avisado) return false
    this.avisado = true
    return true
  }
}

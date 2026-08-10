/**
 * Costo de una corrida del agente.
 *
 * Regla dura del producto (DECISIONS.md D16): nada de "créditos". El costo se mide
 * en dólares y en unidades concretas, se registra siempre, y hay un tope duro que
 * corta la corrida antes de gastar de más.
 *
 * Referencia de la que partimos: menos de US$ 0,50 por auditoría completa
 * (todas las tareas). Si una corrida se pasa, el tope aborta y el resultado dice
 * exactamente en qué se fue la plata.
 *
 * Lo usan: `driver.ts`, `index.ts` y las tareas.
 */

import 'server-only'

import type { CostBreakdown, CostEntry } from '@/lib/types/domain'
import type { LlmUsage } from './types'

/** Precio por millón de tokens. Lo puede pisar quien arma la corrida. */
export interface ModelPricing {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

/**
 * Precios de referencia (Anthropic, agosto 2026). Son una estimación de respaldo:
 * si el frente que provee `complete` informa su propio `costUsd` o el modelo usado,
 * eso manda. Nunca se inventa un precio si vino uno de arriba.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { inputUsdPerMillion: 5, outputUsdPerMillion: 25 },
  'claude-sonnet-5': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  'claude-haiku-4-5': { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
}

/** El agente conduce el navegador con un modelo intermedio: barato y suficiente. */
export const DEFAULT_MODEL_KEY = 'claude-sonnet-5'

/**
 * Costo de tener un navegador abierto, por minuto.
 * Es el precio aproximado de un contenedor chico corriendo Chromium sin interfaz.
 * Se deja configurable porque cambia con la infraestructura donde se despliegue.
 */
export const DEFAULT_BROWSER_USD_PER_MINUTE = 0.01

/** Aproximación de tokens cuando el proveedor no informa el consumo. */
const CHARS_PER_TOKEN = 3.8

export class CostCapExceededError extends Error {
  readonly totalUsd: number
  readonly capUsd: number

  constructor(totalUsd: number, capUsd: number) {
    super(
      `La corrida se detuvo al llegar al tope de gasto: US$ ${totalUsd.toFixed(4)} sobre un límite de US$ ${capUsd.toFixed(2)}.`,
    )
    this.name = 'CostCapExceededError'
    this.totalUsd = totalUsd
    this.capUsd = capUsd
  }
}

export interface CostMeterOptions {
  /** Tope duro. Al superarlo, la corrida aborta. */
  hardCapUsd?: number
  browserUsdPerMinute?: number
  pricing?: Record<string, ModelPricing>
  defaultModelKey?: string
  /** Se llama cada vez que cambia el acumulado, para mostrarlo en vivo. */
  onChange?: (totalUsd: number) => void
}

export class CostMeter {
  private readonly entries: CostEntry[] = []
  private readonly hardCapUsd: number
  private readonly browserUsdPerMinute: number
  private readonly pricing: Record<string, ModelPricing>
  private readonly defaultModelKey: string
  private readonly onChange?: (totalUsd: number) => void

  constructor(options: CostMeterOptions = {}) {
    this.hardCapUsd = options.hardCapUsd ?? 0.5
    this.browserUsdPerMinute = options.browserUsdPerMinute ?? DEFAULT_BROWSER_USD_PER_MINUTE
    this.pricing = options.pricing ?? DEFAULT_PRICING
    this.defaultModelKey = options.defaultModelKey ?? DEFAULT_MODEL_KEY
    this.onChange = options.onChange
  }

  /** Registra una llamada al modelo. Devuelve lo que costó esa llamada. */
  recordLlm(usage: LlmUsage | undefined, detail: string, promptChars = 0, replyChars = 0): number {
    const inputTokens = usage?.inputTokens ?? Math.ceil(promptChars / CHARS_PER_TOKEN)
    const outputTokens = usage?.outputTokens ?? Math.ceil(replyChars / CHARS_PER_TOKEN)
    const costUsd = usage?.costUsd ?? this.estimateLlmCost(inputTokens, outputTokens, usage?.model)

    this.push({
      category: 'llm',
      units: inputTokens + outputTokens,
      unitLabel: 'tokens',
      costUsd,
      detail,
    })
    return costUsd
  }

  /** Registra tiempo de navegador. */
  recordBrowser(durationMs: number, detail: string): number {
    const minutes = durationMs / 60_000
    const costUsd = minutes * this.browserUsdPerMinute
    this.push({
      category: 'browser_agent',
      units: Number(minutes.toFixed(3)),
      unitLabel: 'minutos de navegador',
      costUsd,
      detail,
    })
    return costUsd
  }

  private estimateLlmCost(inputTokens: number, outputTokens: number, model?: string): number {
    const pricing = (model && this.pricing[model]) || this.pricing[this.defaultModelKey]
    if (!pricing) return 0
    return (
      (inputTokens / 1_000_000) * pricing.inputUsdPerMillion +
      (outputTokens / 1_000_000) * pricing.outputUsdPerMillion
    )
  }

  private push(entry: CostEntry): void {
    this.entries.push(entry)
    this.onChange?.(this.totalUsd)
  }

  get totalUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0)
  }

  get capUsd(): number {
    return this.hardCapUsd
  }

  get remainingUsd(): number {
    return Math.max(0, this.hardCapUsd - this.totalUsd)
  }

  isOverCap(): boolean {
    return this.totalUsd >= this.hardCapUsd
  }

  /** Tira si ya se pasó del tope. Se llama antes de cada paso caro. */
  assertUnderCap(): void {
    if (this.isOverCap()) throw new CostCapExceededError(this.totalUsd, this.hardCapUsd)
  }

  breakdown(): CostBreakdown {
    return { entries: [...this.entries], totalUsd: this.totalUsd }
  }

  /** Costo acumulado agrupado por tarea, leyendo la etiqueta del detalle. */
  costFor(detailPrefix: string): number {
    return this.entries
      .filter((entry) => entry.detail?.startsWith(detailPrefix))
      .reduce((sum, entry) => sum + entry.costUsd, 0)
  }

  /** Texto para mostrarle al usuario antes o después de gastar. Sin jerga, en dólares. */
  describePlain(): string {
    const total = this.totalUsd
    if (total < 0.01) return 'Esta revisión costó menos de un centavo de dólar.'
    return `Esta revisión costó US$ ${total.toFixed(2)}.`
  }
}

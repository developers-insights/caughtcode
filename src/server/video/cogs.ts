/**
 * Costo real de producir un clip.
 *
 * Lo usa: `src/server/video/index.ts` (lo guarda en cada video) y
 * `scripts/medir-cogs.ts` (lo promedia sobre varias corridas).
 *
 * Requisito de producto: **el costo de render se mide, no se estima.** Sin un
 * número medido no se puede fijar precio ni detectar que una regresión de
 * performance nos comió el margen. Por eso el render devuelve `computeMs` de
 * reloj y acá se convierte a dólares con el precio por minuto de máquina, en vez
 * de multiplicar segundos de video por una constante inventada.
 *
 * `pricing.ts` tiene hoy `RENDER_COMPUTE_MINUTES_PER_VIDEO_SECOND` marcado como
 * ESTIMADO. `calibracionRender()` devuelve el valor real observado para que ese
 * número se pueda reemplazar por uno medido — es el insumo concreto que este
 * módulo existe para producir.
 */

import type { CostBreakdown, CostCategory, CostEntry } from '@/lib/types/domain'
import {
  RENDER_USD_PER_COMPUTE_MINUTE,
  roundUsd,
} from '@/server/cost/pricing'

export interface Contador {
  sumar(entrada: CostEntry): void
  resumen(): CostBreakdown
  totalDe(categoria: CostCategory): number
}

/** Junta los costos de las cuatro etapas y los deja listos para guardar. */
export function crearContador(): Contador {
  const entradas: CostEntry[] = []

  return {
    sumar(entrada) {
      if (entrada.costUsd === 0 && entrada.units === 0) return
      entradas.push({ ...entrada, costUsd: roundUsd(entrada.costUsd) })
    },
    resumen() {
      return {
        entries: [...entradas],
        totalUsd: roundUsd(entradas.reduce((a, e) => a + e.costUsd, 0)),
      }
    },
    totalDe(categoria) {
      return roundUsd(
        entradas.filter((e) => e.category === categoria).reduce((a, e) => a + e.costUsd, 0),
      )
    },
  }
}

/**
 * Costo del render a partir del tiempo de máquina realmente consumido.
 * `computeMs` incluye levantar Chromium, grabar y codificar: es lo que se paga
 * en un worker, no una proyección sobre la duración del clip.
 */
export function costoRenderMedido(computeMs: number): number {
  const minutos = Math.max(0, computeMs) / 60_000
  return roundUsd(minutos * RENDER_USD_PER_COMPUTE_MINUTE)
}

export interface CalibracionRender {
  /** Minutos de máquina por segundo de video final. Medido, no estimado. */
  minutosPorSegundoDeVideo: number
  /** Cuánto tarda el render comparado con la duración del clip. 1 = tiempo real. */
  vecesTiempoReal: number
  computeMs: number
  videoSegundos: number
}

/**
 * El número que hay que llevar a `pricing.ts` para dejar de estimar.
 * Se calcula por clip; `scripts/medir-cogs.ts` lo promedia sobre N corridas,
 * que es lo mínimo para que sirva.
 */
export function calibracionRender(computeMs: number, videoMs: number): CalibracionRender {
  const videoSegundos = Math.max(0.001, videoMs / 1000)
  const minutos = Math.max(0, computeMs) / 60_000
  return {
    minutosPorSegundoDeVideo: Math.round((minutos / videoSegundos) * 100_000) / 100_000,
    vecesTiempoReal: Math.round((computeMs / (videoSegundos * 1000)) * 100) / 100,
    computeMs: Math.round(computeMs),
    videoSegundos: Math.round(videoSegundos * 100) / 100,
  }
}

export interface DesgloseClip {
  guionUsd: number
  vozUsd: number
  renderUsd: number
  totalUsd: number
  caracteresNarrados: number
  computeMs: number
  videoMs: number
  calibracion: CalibracionRender
}

export function desglosar(
  breakdown: CostBreakdown,
  computeMs: number,
  videoMs: number,
): DesgloseClip {
  const porCategoria = (c: CostCategory) =>
    roundUsd(breakdown.entries.filter((e) => e.category === c).reduce((a, e) => a + e.costUsd, 0))

  const caracteres = breakdown.entries
    .filter((e) => e.category === 'tts')
    .reduce((a, e) => a + e.units, 0)

  return {
    guionUsd: porCategoria('llm'),
    vozUsd: porCategoria('tts'),
    renderUsd: porCategoria('render'),
    totalUsd: breakdown.totalUsd,
    caracteresNarrados: Math.round(caracteres),
    computeMs: Math.round(computeMs),
    videoMs: Math.round(videoMs),
    calibracion: calibracionRender(computeMs, videoMs),
  }
}

/** Promedio de varias corridas, para el reporte de `medir-cogs`. */
export function promediar(clips: DesgloseClip[]): DesgloseClip | null {
  if (clips.length === 0) return null
  const media = (f: (c: DesgloseClip) => number) =>
    clips.reduce((a, c) => a + f(c), 0) / clips.length

  const computeMs = media((c) => c.computeMs)
  const videoMs = media((c) => c.videoMs)

  return {
    guionUsd: roundUsd(media((c) => c.guionUsd)),
    vozUsd: roundUsd(media((c) => c.vozUsd)),
    renderUsd: roundUsd(media((c) => c.renderUsd)),
    totalUsd: roundUsd(media((c) => c.totalUsd)),
    caracteresNarrados: Math.round(media((c) => c.caracteresNarrados)),
    computeMs: Math.round(computeMs),
    videoMs: Math.round(videoMs),
    calibracion: calibracionRender(computeMs, videoMs),
  }
}

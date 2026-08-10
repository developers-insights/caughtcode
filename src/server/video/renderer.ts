/**
 * Contrato del motor de video — cierre de la decisión D11.
 *
 * Lo usa: `src/server/video/index.ts`. Lo implementan `render/web.ts` (default)
 * y `render/remotion.ts` (stub).
 *
 * ── Por qué el motor es HTML + Playwright y no Motion Canvas ni Remotion ──
 *
 * D11 estaba abierta entre Motion Canvas (MIT) y Remotion (licencia con zona
 * gris para SaaS que renderiza para terceros, y piso de US$100/mes en el tier
 * que nos tocaría). Al construirlo quedó claro que la pregunta estaba mal
 * planteada: los dos son motores de **composición** de escenas, y nosotros casi
 * no componemos. Cerca del 70% del clip es la grabación del agente. Lo que hay
 * que hacer es recortar, acercar, señalar y narrar.
 *
 * Con Playwright y ffmpeg —los dos ya instalados— eso se resuelve entero:
 *
 *  1. **Licencia:** cero. Remotion cobra y su licencia exige aprobación escrita
 *     para que terceros rendericen sus proyectos; nuestro caso probablemente
 *     esté del lado bueno, pero "probablemente" no es una base para facturar.
 *  2. **Mismos tokens que la app:** la escena es una página web que lee
 *     `src/styles/tokens.css`. El rojo del video no se *parece* al rojo de la
 *     interfaz: es la misma variable. Con un motor de video habría que
 *     mantener dos paletas sincronizadas a mano, y se van a desincronizar.
 *  3. **Cero dependencias nuevas.** Motion Canvas habría sumado un runtime y
 *     un lenguaje de escenas propio para dibujar cuatro cosas.
 *  4. **Quien edita el diseño es el frente de diseño.** CSS, no una API de
 *     animación imperativa.
 *
 * Lo que se resigna: composición fotograma a fotograma determinista. Playwright
 * graba en tiempo real, así que un pico de carga puede tirar cuadros. Se
 * compensa normalizando a 30 fps constantes en la mezcla y, sobre todo, porque
 * la sincronía con la voz **no** depende del render: audio, subtítulos y línea
 * de tiempo leen los mismos offsets calculados en `timing.ts`.
 *
 * `remotion` queda como implementación alternativa detrás de
 * `VIDEO_RENDERER=remotion`, sin implementar y con la licencia sin resolver.
 */

import type { VideoScript } from '@/lib/types/domain'

import type { Cue } from './subtitles'
import type { Tono } from './render/page'
import type { UbicacionEscena } from './timing'

export const ANCHO = 1280
export const ALTO = 720
export const FPS = 30

export interface RenderContexto {
  /** Título del hallazgo, para la cinta superior. */
  titulo: string
  tono: Tono
}

export interface RenderEntrada {
  script: VideoScript
  ubicaciones: UbicacionEscena[]
  cues: Cue[]
  contexto: RenderContexto
  /** Carpeta de trabajo de este render. Se escribe todo acá adentro. */
  workDir: string
  onProgress?: (etapa: string, porcentaje: number) => void
}

export interface RenderSalida {
  /** Video mudo. La voz se pega después, en `mux.ts`. */
  videoPath: string
  /**
   * Cuadros muertos al principio de la grabación, antes de que arrancara la
   * línea de tiempo. `mux.ts` los recorta.
   */
  preRollMs: number
  /** Duración de la línea de tiempo, sin el preRoll. */
  timelineMs: number
  /** Tiempo de máquina que costó el render. Insumo real del costo. */
  computeMs: number
  /** De dónde salieron los tokens de color: 'app' o 'fallback'. */
  origenTokens: 'app' | 'fallback'
}

export interface VideoRenderer {
  readonly id: string
  render(entrada: RenderEntrada): Promise<RenderSalida>
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly renderer: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RenderError'
  }
}

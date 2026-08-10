/**
 * Contrato de voz.
 *
 * Lo usa: `src/server/video/tts/index.ts` (fábrica), `src/server/video/index.ts`
 * (etapa de audio) y `scripts/medir-cogs.ts`. Lo implementan `azure.ts`,
 * `google.ts` y `none.ts`.
 *
 * Regla de D10: cambiar de proveedor es cambiar `TTS_PROVIDER`, nunca tocar
 * código. Por eso la interfaz no filtra nada específico de Azure ni de Google.
 *
 * Sin `import 'server-only'` a propósito: ese paquete tira una excepción fuera
 * del runtime de React Server, y estos módulos corren en vitest y bajo tsx
 * (mismo criterio que `src/server/jobs/db.ts`).
 */

/** Dialecto de SSML. Azure y Google no hablan exactamente el mismo. */
export type SsmlDialect = 'azure' | 'google'

export type TtsProviderId = 'azure' | 'google' | 'none'

export interface TtsSynthesisOptions {
  /** Carpeta donde dejar el archivo de audio. Se crea si no existe. */
  outDir: string
  /** Nombre del archivo sin extensión. */
  basename: string
  /** Voz concreta. Si falta, se usa `provider.defaultVoice`. */
  voice?: string
}

export interface TtsResult {
  /** Ruta absoluta al WAV generado: 24 kHz, mono, 16 bits. */
  audioPath: string
  /** Duración real medida del archivo, no estimada. */
  durationMs: number
  costUsd: number
  provider: TtsProviderId
  voice: string
  /** Caracteres facturables (texto hablado, sin las etiquetas de SSML). */
  characters: number
  /** true si el audio salió de la caché en disco y no se volvió a pagar. */
  cached: boolean
}

export interface TtsProvider {
  readonly id: TtsProviderId
  readonly name: string
  readonly ssmlDialect: SsmlDialect
  readonly defaultVoice: string
  /**
   * Sintetiza `ssml` y deja un WAV de 24 kHz mono 16 bits en disco.
   * Todo el resto del sistema asume ese formato: es lo que permite medir la
   * duración leyendo el encabezado, sin invocar a ffprobe (que, ojo,
   * `ffmpeg-static` NO trae).
   */
  synthesize(ssml: string, opts: TtsSynthesisOptions): Promise<TtsResult>
}

/** Formato de audio que produce y consume todo el pipeline de video. */
export const AUDIO_SAMPLE_RATE = 24_000
export const AUDIO_CHANNELS = 1
export const AUDIO_BITS_PER_SAMPLE = 16

export class TtsError extends Error {
  constructor(
    message: string,
    readonly provider: TtsProviderId,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'TtsError'
  }
}

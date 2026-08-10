/**
 * Voz por Google Cloud Text-to-Speech (Chirp3-HD). Alternativa de D10.
 *
 * Lo usa: `src/server/video/tts/index.ts` cuando `TTS_PROVIDER=google`.
 *
 * Ojo con el idioma: Google **no publica voces es-AR** en la familia Chirp3-HD.
 * Lo más cercano es es-US o es-ES. Por eso Azure es el default y esto es el
 * plan B: cuando el acento importa, Azure gana; cuando importa la cuota o la
 * disponibilidad regional, se cambia la variable y listo.
 *
 * Pedimos LINEAR16 a 24 kHz porque es lo que el resto del pipeline sabe medir
 * sin ffprobe.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { caracteresHablados } from './ssml'
import { ensureWav, readWavDurationMs } from './wav'
import { TtsError, type TtsProvider, type TtsResult, type TtsSynthesisOptions } from './types'

export interface GoogleConfig {
  apiKey: string
  voice?: string
  languageCode?: string
  timeoutMs?: number
}

const VOZ_DEFAULT = 'es-US-Chirp3-HD-Achernar'
const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize'

export function crearProveedorGoogle(config: GoogleConfig): TtsProvider {
  const voiceDefault = config.voice ?? VOZ_DEFAULT
  const timeoutMs = config.timeoutMs ?? 30_000

  return {
    id: 'google',
    name: 'Google Cloud TTS',
    ssmlDialect: 'google',
    defaultVoice: voiceDefault,

    async synthesize(ssml: string, opts: TtsSynthesisOptions): Promise<TtsResult> {
      const voice = opts.voice ?? voiceDefault
      const languageCode = config.languageCode ?? idiomaDeVoz(voice)
      const characters = caracteresHablados(ssml)

      const control = new AbortController()
      const reloj = setTimeout(() => control.abort(), timeoutMs)

      let base64: string
      try {
        const respuesta = await fetch(`${ENDPOINT}?key=${encodeURIComponent(config.apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { ssml },
            voice: { languageCode, name: voice },
            audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24_000 },
          }),
          signal: control.signal,
        })

        if (!respuesta.ok) {
          const detalle = (await respuesta.text().catch(() => '')).slice(0, 400)
          throw new TtsError(
            `Google TTS respondió ${respuesta.status}. ${detalle || 'Sin detalle.'}`,
            'google',
          )
        }

        const cuerpo = (await respuesta.json()) as { audioContent?: string }
        if (!cuerpo.audioContent) {
          throw new TtsError('Google TTS respondió sin campo "audioContent".', 'google')
        }
        base64 = cuerpo.audioContent
      } catch (error) {
        if (error instanceof TtsError) throw error
        if (error instanceof Error && error.name === 'AbortError') {
          throw new TtsError(`Google TTS no respondió en ${timeoutMs} ms.`, 'google', error)
        }
        throw new TtsError(`No se pudo hablar con Google TTS: ${describir(error)}`, 'google', error)
      } finally {
        clearTimeout(reloj)
      }

      const wav = ensureWav(Buffer.from(base64, 'base64'))
      await mkdir(opts.outDir, { recursive: true })
      const audioPath = path.join(opts.outDir, `${opts.basename}.wav`)
      await writeFile(audioPath, wav)

      return {
        audioPath,
        durationMs: readWavDurationMs(wav),
        costUsd: costoGoogle(characters),
        provider: 'google',
        voice,
        characters,
        cached: false,
      }
    },
  }
}

/** Chirp3-HD ≈ US$30 por millón de caracteres. */
export function costoGoogle(characters: number): number {
  const bruto = (Math.max(0, characters) * 30) / 1_000_000
  return Math.round(bruto * 1_000_000) / 1_000_000
}

/** "es-US-Chirp3-HD-Achernar" → "es-US". */
export function idiomaDeVoz(voice: string): string {
  const m = /^([a-z]{2}-[A-Z]{2})/.exec(voice)
  return m ? m[1] : 'es-US'
}

function describir(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

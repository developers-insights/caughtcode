/**
 * Voz por Azure Speech (REST). Proveedor por default según D10.
 *
 * Lo usa: `src/server/video/tts/index.ts` cuando `TTS_PROVIDER=azure`.
 *
 * Por qué Azure y no ElevenLabs: 5-10x más barato por caracter y, sobre todo,
 * tiene voces **es-AR** de verdad (Tomás, Elena), no "español neutro". Nuestro
 * usuario es rioplatense y lo nota.
 *
 * Pedimos `riff-24khz-16bit-mono-pcm` a propósito: es el formato que el resto
 * del pipeline sabe medir sin ffprobe (ver `wav.ts`).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { caracteresHablados } from './ssml'
import { ensureWav, readWavDurationMs } from './wav'
import { TtsError, type TtsProvider, type TtsResult, type TtsSynthesisOptions } from './types'

export interface AzureConfig {
  key: string
  region: string
  /** Voz es-AR. Tomás y Elena son las dos neuronales rioplatenses. */
  voice?: string
  /** Timeout de la llamada, en ms. */
  timeoutMs?: number
}

const FORMATO = 'riff-24khz-16bit-mono-pcm'
const VOZ_DEFAULT = 'es-AR-TomasNeural'

export function crearProveedorAzure(config: AzureConfig): TtsProvider {
  const voiceDefault = config.voice ?? VOZ_DEFAULT
  const timeoutMs = config.timeoutMs ?? 30_000
  const endpoint = `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`

  return {
    id: 'azure',
    name: 'Azure Speech',
    ssmlDialect: 'azure',
    defaultVoice: voiceDefault,

    async synthesize(ssml: string, opts: TtsSynthesisOptions): Promise<TtsResult> {
      const voice = opts.voice ?? voiceDefault
      const characters = caracteresHablados(ssml)

      const control = new AbortController()
      const reloj = setTimeout(() => control.abort(), timeoutMs)

      let bytes: Uint8Array
      try {
        const respuesta = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': config.key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': FORMATO,
            'User-Agent': 'caughtcode',
          },
          body: ssml,
          signal: control.signal,
        })

        if (!respuesta.ok) {
          const detalle = (await respuesta.text().catch(() => '')).slice(0, 400)
          throw new TtsError(
            `Azure Speech respondió ${respuesta.status}. ${detalle || 'Sin detalle.'}`,
            'azure',
          )
        }
        bytes = new Uint8Array(await respuesta.arrayBuffer())
      } catch (error) {
        if (error instanceof TtsError) throw error
        if (error instanceof Error && error.name === 'AbortError') {
          throw new TtsError(`Azure Speech no respondió en ${timeoutMs} ms.`, 'azure', error)
        }
        throw new TtsError(`No se pudo hablar con Azure Speech: ${describir(error)}`, 'azure', error)
      } finally {
        clearTimeout(reloj)
      }

      if (bytes.byteLength === 0) {
        throw new TtsError('Azure Speech devolvió un audio vacío.', 'azure')
      }

      const wav = ensureWav(bytes)
      await mkdir(opts.outDir, { recursive: true })
      const audioPath = path.join(opts.outDir, `${opts.basename}.wav`)
      await writeFile(audioPath, wav)

      return {
        audioPath,
        durationMs: readWavDurationMs(wav),
        // El precio depende de si la voz es HD: cuesta casi el doble.
        costUsd: costoAzure(characters, voice),
        provider: 'azure',
        voice,
        characters,
        cached: false,
      }
    },
  }
}

/** Azure Neural ≈ US$16 por millón de caracteres; Neural HD ≈ US$30. */
export function costoAzure(characters: number, voice: string): number {
  const esHd = /hd/i.test(voice)
  const porMillon = esHd ? 30 : 16
  const bruto = (Math.max(0, characters) * porMillon) / 1_000_000
  return Math.round(bruto * 1_000_000) / 1_000_000
}

function describir(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

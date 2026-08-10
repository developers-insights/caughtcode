/**
 * Proveedor de voz "sin voz": genera silencio de la duración que habría tenido
 * la locución.
 *
 * Lo usa: los tests, `scripts/medir-cogs.ts` sin claves, y cualquier entorno
 * donde no haya credenciales de Azure ni de Google.
 *
 * No es un mock de mentira: produce un WAV real, con la duración estimada a
 * partir del texto y de las pausas declaradas en el SSML. Eso hace que el clip
 * resultante tenga la misma estructura temporal que uno narrado — se puede
 * verificar la banda de 60-90 s, el sincronismo de subtítulos y la mezcla, sin
 * gastar un centavo.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { desarmarSsml } from './ssml'
import { estimarVozMs } from '../timing'
import { silenceWav } from './wav'
import { readWavDurationMs } from './wav'
import type { TtsProvider, TtsResult, TtsSynthesisOptions } from './types'

export function crearProveedorNone(): TtsProvider {
  return {
    id: 'none',
    name: 'Sin voz (silencio)',
    ssmlDialect: 'azure',
    defaultVoice: 'silencio',

    async synthesize(ssml: string, opts: TtsSynthesisOptions): Promise<TtsResult> {
      const { texto, pausasMs } = desarmarSsml(ssml)
      const durationMs = Math.max(400, estimarVozMs(texto, pausasMs))

      await mkdir(opts.outDir, { recursive: true })
      const audioPath = path.join(opts.outDir, `${opts.basename}.wav`)
      const wav = silenceWav(durationMs)
      await writeFile(audioPath, wav)

      return {
        audioPath,
        // Se relee del archivo: la duración que devolvemos siempre es medida.
        durationMs: readWavDurationMs(wav),
        costUsd: 0,
        provider: 'none',
        voice: 'silencio',
        characters: texto.length,
        cached: false,
      }
    },
  }
}

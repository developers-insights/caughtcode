/**
 * Ensamblado de la pista de voz.
 *
 * Lo usa: `src/server/video/index.ts`, entre la etapa de voz y la de mezcla.
 *
 * Toma las frases sueltas que devolvió el TTS y las ubica en un único WAV, cada
 * una en su offset exacto. **Ese offset es el mismo que usa la línea de tiempo
 * de la página** (los dos salen de `ubicarEscenas` en `timing.ts`), y eso es lo
 * único que garantiza que la voz caiga sobre la escena que corresponde. No hay
 * ajuste posterior ni corrección de deriva: hay una sola tabla de tiempos.
 *
 * Se arma en Node y no con un grafo de filtros de ffmpeg porque los segmentos ya
 * están todos en el mismo formato (24 kHz, mono, 16 bits sin comprimir):
 * pegarlos es copiar bytes en un offset. Menos procesos, sin filtro que
 * interpretar cuando algo sale mal, y testeable sin binarios.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { correrFfmpeg } from './ffmpeg'
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
} from './tts/types'
import { esFormatoCanonico, readWavInfo, wavHeader } from './tts/wav'

export interface SegmentoVoz {
  /** WAV de una frase. */
  audioPath: string
  /** Cuándo tiene que empezar a sonar, en ms desde el inicio del clip. */
  startMs: number
}

export interface PistaVoz {
  audioPath: string
  durationMs: number
  /** Segmentos que no entraban y se corrieron o recortaron. */
  avisos: string[]
}

const BYTES_POR_MUESTRA = AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8)

export function msAMuestras(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * AUDIO_SAMPLE_RATE))
}

/**
 * Une los segmentos en una sola pista de `totalMs`.
 * Si un segmento se pasa del final, se recorta y se avisa: preferimos un clip
 * de largo exacto con un aviso explícito antes que un video que se estira solo.
 */
export async function ensamblarVoz(
  segmentos: SegmentoVoz[],
  totalMs: number,
  destino: string,
): Promise<PistaVoz> {
  const avisos: string[] = []
  const totalMuestras = msAMuestras(totalMs)
  const pista = Buffer.alloc(totalMuestras * BYTES_POR_MUESTRA)

  for (const segmento of segmentos) {
    const crudo = await readFile(segmento.audioPath)
    const info = readWavInfo(crudo)

    let muestras: Buffer
    if (esFormatoCanonico(info)) {
      muestras = crudo.subarray(info.dataOffset, info.dataOffset + info.dataBytes)
    } else {
      // Un proveedor devolvió otro formato: se convierte antes de pegar.
      avisos.push(
        `${path.basename(segmento.audioPath)} vino en ${info.sampleRate} Hz / ${info.channels} canal(es); se convirtió.`,
      )
      muestras = await convertirACanonico(segmento.audioPath)
    }

    const desde = msAMuestras(segmento.startMs) * BYTES_POR_MUESTRA
    if (desde >= pista.length) {
      avisos.push(`Una frase quedaba fuera del clip (arrancaba en ${Math.round(segmento.startMs)} ms) y se descartó.`)
      continue
    }

    const cabe = pista.length - desde
    if (muestras.length > cabe) {
      avisos.push(
        `Una frase no entraba entera en el clip: se recortaron ${Math.round(
          ((muestras.length - cabe) / BYTES_POR_MUESTRA / AUDIO_SAMPLE_RATE) * 1000,
        )} ms.`,
      )
    }
    muestras.copy(pista, desde, 0, Math.min(muestras.length, cabe))
  }

  await mkdir(path.dirname(destino), { recursive: true })
  await writeFile(destino, Buffer.concat([wavHeader(pista.length), pista]))

  return { audioPath: destino, durationMs: totalMs, avisos }
}

/** Conversión de emergencia: solo si un proveedor no respetó el formato pedido. */
async function convertirACanonico(origen: string): Promise<Buffer> {
  const destino = `${origen}.canonico.wav`
  await correrFfmpeg([
    '-hide_banner',
    '-y',
    '-i',
    origen,
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    String(AUDIO_CHANNELS),
    '-c:a',
    'pcm_s16le',
    destino,
  ])
  const crudo = await readFile(destino)
  const info = readWavInfo(crudo)
  return crudo.subarray(info.dataOffset, info.dataOffset + info.dataBytes)
}

/** ¿Toda la pista es silencio? Sirve para no correr normalización sobre nada. */
export function esSilencio(muestras: Buffer): boolean {
  for (let i = 0; i < muestras.length; i += 2) {
    if (muestras.readInt16LE(i) !== 0) return false
  }
  return true
}

export async function pistaEsSilencio(audioPath: string): Promise<boolean> {
  const crudo = await readFile(audioPath)
  const info = readWavInfo(crudo)
  return esSilencio(crudo.subarray(info.dataOffset, info.dataOffset + info.dataBytes))
}

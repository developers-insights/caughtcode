/**
 * Herramienta de verificación: sacar un cuadro del video en un milisegundo dado y
 * compararlo con la captura de ese paso.
 *
 * Sirve para probar lo único que el frente de video no puede verificar solo: que el
 * `atMs` de cada paso apunte de verdad al momento en que pasó eso en la grabación.
 * Si estos tiempos están corridos, todos los clips salen mal.
 *
 * Sobre cómo se comparan las imágenes (y por qué no de la forma obvia): la primera
 * versión usaba un promedio perceptual de 16x16. No servía. Al aplastar 1280x800 en
 * 16x16, una página con fondo claro y texto chico queda casi toda del mismo tono, y
 * el umbral del promedio devuelve casi los mismos bits para pantallas distintas: dos
 * capturas de páginas diferentes daban distancia 0. Encima, el encabezado de arriba y
 * el cartel de cookies de abajo son idénticos en todas las páginas y se comían el
 * poco contraste que quedaba.
 *
 * La versión que sí discrimina: se recorta la franja central (se tira el encabezado y
 * el cartel fijo), se reduce a 32x32 en gris, y se compara la diferencia promedio de
 * los valores reales de los píxeles. Sin umbral: la magnitud de la diferencia es
 * justamente la señal que el promedio perceptual tiraba a la basura.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/* eslint-disable @typescript-eslint/no-require-imports */
const ffmpegPath: string | null = (() => {
  try {
    const resolved = require('ffmpeg-static') as string | { default: string }
    const value = typeof resolved === 'string' ? resolved : resolved.default
    return value && existsSync(value) ? value : null
  } catch {
    return null
  }
})()
/* eslint-enable @typescript-eslint/no-require-imports */

export const hasFfmpeg = ffmpegPath !== null

const SIZE = 32

/**
 * Se queda con la franja central: fuera el encabezado (13% de arriba) y el cartel de
 * cookies (15% de abajo), que son iguales en todas las pantallas y no aportan nada.
 */
const CROP_AND_SCALE = `crop=iw:ih*0.72:0:ih*0.13,scale=${SIZE}:${SIZE},format=gray`

async function rawGray(args: string[]): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('ffmpeg no está disponible')
  const { stdout } = await run(ffmpegPath, args, {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout as unknown as Buffer
}

/** Cuadro del video en el milisegundo pedido, ya recortado y reducido. */
export async function frameAt(videoPath: string, atMs: number): Promise<Buffer> {
  const seconds = (atMs / 1000).toFixed(3)
  // `-ss` después de `-i` es búsqueda exacta (más lenta, pero estos videos duran segundos).
  return rawGray([
    '-v', 'error',
    '-i', videoPath,
    '-ss', seconds,
    '-frames:v', '1',
    '-vf', CROP_AND_SCALE,
    '-f', 'rawvideo',
    '-',
  ])
}

/** Una captura PNG reducida al mismo formato, para poder compararlas. */
export async function imageFingerprint(imagePath: string): Promise<Buffer> {
  return rawGray([
    '-v', 'error',
    '-i', imagePath,
    '-vf', CROP_AND_SCALE,
    '-f', 'rawvideo',
    '-',
  ])
}

/** Duración real del archivo, decodificándolo entero (el encabezado suele mentir). */
export async function videoDurationMs(videoPath: string): Promise<number> {
  if (!ffmpegPath) throw new Error('ffmpeg no está disponible')
  // ffmpeg escribe el progreso en stderr y termina con código 0: hay que leerlo
  // igual, no solo cuando falla.
  let stderr = ''
  try {
    const result = await run(ffmpegPath, ['-v', 'info', '-i', videoPath, '-f', 'null', '-'], {
      maxBuffer: 16 * 1024 * 1024,
    })
    stderr = String(result.stderr ?? '')
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr ?? '')
  }
  return parseLastTime(stderr)
}

function parseLastTime(stderr: string): number {
  const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+)\.(\d+)/g)]
  if (matches.length === 0) return 0
  const last = matches[matches.length - 1]
  return (
    Number(last[1]) * 3_600_000 +
    Number(last[2]) * 60_000 +
    Number(last[3]) * 1000 +
    Number(last[4]) * 10
  )
}

/**
 * Diferencia promedio entre los píxeles de dos imágenes, en la escala 0..255.
 * 0 = idénticas. Un video comprimido contra su propia captura suele dar menos de 10;
 * dos pantallas distintas de la misma app, bastante más.
 */
export function pixelDistance(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length, SIZE * SIZE)
  if (length === 0) return Number.POSITIVE_INFINITY
  let total = 0
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(a[index] - b[index])
  }
  return total / length
}

/** ¿El cuadro es una pantalla en blanco o negro? Sirve para descartar cuadros vacíos. */
export function isBlank(gray: Buffer): boolean {
  const pixels = [...gray.subarray(0, SIZE * SIZE)]
  if (pixels.length === 0) return true
  const min = Math.min(...pixels)
  const max = Math.max(...pixels)
  return max - min < 6
}

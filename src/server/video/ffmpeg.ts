/**
 * Envoltorio de ffmpeg.
 *
 * Lo usa: `mux.ts` (mezcla final), `render/web.ts` (normalización) y
 * `scripts/medir-cogs.ts`.
 *
 * Sin `fluent-ffmpeg` a propósito: se spawnea el binario con argumentos
 * explícitos. Un array de strings se lee, se copia a una terminal y se depura;
 * una cadena de builders, no.
 *
 * OJO, dato que cuesta descubrir: **`ffmpeg-static` empaqueta solo `ffmpeg`,
 * no `ffprobe`**. Por eso la duración se mide parseando el stderr de ffmpeg y
 * no hay ninguna dependencia de ffprobe en runtime.
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

import ffmpegStatic from 'ffmpeg-static'

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

let binarioCache: string | null = null

/** Orden: FFMPEG_PATH del entorno, el binario empaquetado, el del sistema. */
export async function resolverFfmpeg(entorno: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (binarioCache) return binarioCache

  const candidatos = [entorno.FFMPEG_PATH, ffmpegStatic as string | null, 'ffmpeg'].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  )

  for (const candidato of candidatos) {
    if (candidato === 'ffmpeg') {
      binarioCache = candidato
      return candidato
    }
    try {
      await access(candidato, constants.X_OK)
      binarioCache = candidato
      return candidato
    } catch {
      // seguimos probando
    }
  }
  throw new Error(
    'No encontré ffmpeg. Instalá el paquete `ffmpeg-static` o definí FFMPEG_PATH apuntando al binario.',
  )
}

/** Solo para tests: olvida el binario resuelto. */
export function olvidarFfmpeg(): void {
  binarioCache = null
}

export interface CorrerOpciones {
  /** Tiempo máximo antes de matar el proceso. */
  timeoutMs?: number
  /** Recibe cada línea de stderr, para mostrar progreso. */
  onStderr?: (linea: string) => void
  entorno?: NodeJS.ProcessEnv
}

export interface CorrerResultado {
  stderr: string
  durationMs: number
}

/**
 * Corre ffmpeg y espera. Si falla, el error trae las últimas líneas de stderr,
 * que es donde ffmpeg pone el motivo real (el exit code solo dice "1").
 */
export async function correrFfmpeg(
  args: string[],
  opciones: CorrerOpciones = {},
): Promise<CorrerResultado> {
  const binario = await resolverFfmpeg(opciones.entorno)
  const timeoutMs = opciones.timeoutMs ?? 10 * 60_000
  const inicio = Date.now()

  return new Promise<CorrerResultado>((resolve, reject) => {
    const proceso = spawn(binario, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let resto = ''
    let matado = false

    const reloj = setTimeout(() => {
      matado = true
      proceso.kill('SIGKILL')
    }, timeoutMs)

    proceso.stderr.setEncoding('utf8')
    proceso.stderr.on('data', (trozo: string) => {
      stderr += trozo
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
      if (opciones.onStderr) {
        resto += trozo
        const lineas = resto.split(/\r?\n|\r/)
        resto = lineas.pop() ?? ''
        for (const linea of lineas) if (linea.trim()) opciones.onStderr(linea.trim())
      }
    })

    proceso.on('error', (error) => {
      clearTimeout(reloj)
      reject(new FfmpegError(`No se pudo ejecutar ffmpeg: ${error.message}`, null, args, stderr))
    })

    proceso.on('close', (code) => {
      clearTimeout(reloj)
      if (matado) {
        reject(new FfmpegError(`ffmpeg no terminó en ${timeoutMs} ms y se cortó.`, code, args, stderr))
        return
      }
      if (code !== 0) {
        reject(new FfmpegError(`ffmpeg terminó con código ${code}.\n${ultimasLineas(stderr, 12)}`, code, args, stderr))
        return
      }
      resolve({ stderr, durationMs: Date.now() - inicio })
    })
  })
}

export function ultimasLineas(texto: string, cuantas: number): string {
  return texto.split(/\r?\n/).filter(Boolean).slice(-cuantas).join('\n')
}

/* ── Inspección ───────────────────────────────────────────────────────── */

export interface InfoMedia {
  durationMs: number
  tieneVideo: boolean
  tieneAudio: boolean
  ancho?: number
  alto?: number
  fps?: number
}

const RE_DURACION = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,3})/
const RE_VIDEO = /Stream #\d+:\d+.*?: Video: ([^\n]+)/
const RE_AUDIO = /Stream #\d+:\d+.*?: Audio: /
const RE_TAMANO = /,\s(\d{2,5})x(\d{2,5})[,\s]/
const RE_FPS = /,\s*([\d.]+)\s*fps/

/**
 * Lee duración, pistas y tamaño usando el propio ffmpeg.
 * `ffmpeg -i archivo` sin salida termina con código 1 ("At least one output
 * file must be specified") y escribe la info en stderr: eso es lo que leemos.
 */
export function parsearInfoMedia(stderr: string): InfoMedia {
  const d = RE_DURACION.exec(stderr)
  const durationMs = d
    ? (Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000 +
      Number(d[4].padEnd(3, '0'))
    : 0

  const video = RE_VIDEO.exec(stderr)
  const tamano = video ? RE_TAMANO.exec(video[1]) : null
  const fps = video ? RE_FPS.exec(video[1]) : null

  return {
    durationMs,
    tieneVideo: Boolean(video),
    tieneAudio: RE_AUDIO.test(stderr),
    ancho: tamano ? Number(tamano[1]) : undefined,
    alto: tamano ? Number(tamano[2]) : undefined,
    fps: fps ? Number(fps[1]) : undefined,
  }
}

export async function inspeccionar(
  archivo: string,
  opciones: CorrerOpciones = {},
): Promise<InfoMedia> {
  try {
    const { stderr } = await correrFfmpeg(['-hide_banner', '-i', archivo, '-f', 'null', '-'], opciones)
    return parsearInfoMedia(stderr)
  } catch (error) {
    // Sin salida ffmpeg sale con código 1 pero ya escribió lo que necesitamos.
    if (error instanceof FfmpegError && error.stderr.includes('Duration:')) {
      return parsearInfoMedia(error.stderr)
    }
    throw error
  }
}

/**
 * Mezcla final: el video mudo del renderer + la pista de voz → un MP4.
 *
 * Lo usa: `src/server/video/index.ts` (última etapa) y `scripts/medir-cogs.ts`.
 *
 * Qué hace acá y por qué cada cosa:
 *  - **recorta el arranque muerto** (`preRollMs`), que es el tiempo que tardó la
 *    página en quedar lista mientras Playwright ya estaba grabando;
 *  - **normaliza a 30 fps constantes**: Playwright graba a ritmo variable y un
 *    clip con cadencia irregular se nota aunque no se sepa por qué;
 *  - **empareja el volumen** con loudnorm a -16 LUFS, el estándar de audio
 *    hablado en web. Sin esto, un hallazgo suena fuerte y el siguiente bajito;
 *  - **funde entrada y salida**, en imagen y en sonido, para que el clip no
 *    arranque ni termine de golpe;
 *  - **fija la duración exacta** con `-t`, así lo que promete `timing.ts` es lo
 *    que dura el archivo.
 *
 * Sin `fluent-ffmpeg`: se spawnea el binario con argumentos explícitos (ver
 * `ffmpeg.ts`). El array de argumentos que sale en un error se pega tal cual en
 * una terminal y se reproduce el problema.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { correrFfmpeg, FfmpegError, inspeccionar, type InfoMedia } from './ffmpeg'
import { ALTO, ANCHO, FPS } from './renderer'

export interface MezclaOpciones {
  videoPath: string
  /** Pista de voz ya ensamblada. Si falta, el clip sale mudo. */
  audioPath?: string | null
  salidaPath: string
  /** Cuadros muertos a recortar del principio del video. */
  preRollMs?: number
  /** Duración final exacta. */
  durationMs: number
  /** Emparejar volumen. Apagalo si la pista es silencio (TTS_PROVIDER=none). */
  normalizarAudio?: boolean
  onProgress?: (porcentaje: number) => void
  timeoutMs?: number
}

export interface MezclaResultado {
  salidaPath: string
  info: InfoMedia
  computeMs: number
  /** Los argumentos exactos, para poder reproducir el render a mano. */
  args: string[]
}

const FUNDIDO_ENTRADA_S = 0.35
const FUNDIDO_SALIDA_S = 0.5
const FUNDIDO_AUDIO_ENTRADA_S = 0.25
const FUNDIDO_AUDIO_SALIDA_S = 0.6

/** Nivel objetivo de audio hablado. -16 LUFS es lo habitual para web. */
const LUFS_OBJETIVO = -16

function seg(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

export function construirArgumentos(opciones: MezclaOpciones): string[] {
  const totalS = Math.max(0.5, opciones.durationMs / 1000)
  const inicioFundidoSalida = Math.max(0, totalS - FUNDIDO_SALIDA_S)
  const inicioFundidoAudioSalida = Math.max(0, totalS - FUNDIDO_AUDIO_SALIDA_S)
  const conAudio = Boolean(opciones.audioPath)

  const filtroVideo = [
    `fps=${FPS}`,
    `scale=${ANCHO}:${ALTO}:flags=lanczos`,
    'setsar=1',
    `fade=t=in:st=0:d=${FUNDIDO_ENTRADA_S}`,
    `fade=t=out:st=${inicioFundidoSalida.toFixed(3)}:d=${FUNDIDO_SALIDA_S}`,
  ].join(',')

  const filtroAudio = [
    opciones.normalizarAudio === false ? null : `loudnorm=I=${LUFS_OBJETIVO}:TP=-1.5:LRA=11`,
    `afade=t=in:st=0:d=${FUNDIDO_AUDIO_ENTRADA_S}`,
    `afade=t=out:st=${inicioFundidoAudioSalida.toFixed(3)}:d=${FUNDIDO_AUDIO_SALIDA_S}`,
    'aresample=48000',
  ]
    .filter(Boolean)
    .join(',')

  const args = ['-hide_banner', '-nostdin', '-y']

  // El recorte va ANTES del -i: así ffmpeg busca en la entrada en vez de
  // decodificar y tirar todo lo que sobra.
  if (opciones.preRollMs && opciones.preRollMs > 0) {
    args.push('-ss', seg(opciones.preRollMs))
  }
  args.push('-i', opciones.videoPath)

  if (conAudio) args.push('-i', opciones.audioPath!)

  const filtro = conAudio
    ? `[0:v]${filtroVideo}[v];[1:a]${filtroAudio}[a]`
    : `[0:v]${filtroVideo}[v]`

  args.push('-filter_complex', filtro, '-map', '[v]')
  if (conAudio) args.push('-map', '[a]')

  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.0',
    // Un keyframe por segundo: hace que buscar dentro del clip sea inmediato,
    // y el usuario va a rebobinar el momento donde el agente rompió algo.
    '-g', String(FPS),
    '-keyint_min', String(FPS),
  )

  if (conAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '1')
  }

  args.push(
    '-movflags', '+faststart',
    '-r', String(FPS),
    '-t', totalS.toFixed(3),
    opciones.salidaPath,
  )

  return args
}

export async function mezclar(opciones: MezclaOpciones): Promise<MezclaResultado> {
  await mkdir(path.dirname(opciones.salidaPath), { recursive: true })
  const args = construirArgumentos(opciones)
  const totalS = Math.max(0.5, opciones.durationMs / 1000)

  try {
    const { durationMs } = await correrFfmpeg(args, {
      timeoutMs: opciones.timeoutMs ?? 10 * 60_000,
      onStderr: opciones.onProgress
        ? (linea) => {
            const m = /time=(\d+):(\d{2}):(\d{2})\.(\d{2})/.exec(linea)
            if (!m) return
            const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100
            opciones.onProgress!(Math.min(100, Math.round((t / totalS) * 100)))
          }
        : undefined,
    })

    const info = await inspeccionar(opciones.salidaPath)
    return { salidaPath: opciones.salidaPath, info, computeMs: durationMs, args }
  } catch (error) {
    throw new Error(explicarFallo(error, args))
  }
}

/**
 * Traduce el berrinche de ffmpeg a algo accionable.
 * Los tres errores que aparecen de verdad son: falta el códec, falta el archivo
 * de entrada, o no hay lugar en disco.
 */
export function explicarFallo(error: unknown, args: string[]): string {
  if (!(error instanceof FfmpegError)) {
    return `Falló la mezcla del video: ${error instanceof Error ? error.message : String(error)}`
  }

  const stderr = error.stderr
  const comando = `ffmpeg ${args.join(' ')}`

  if (/Unknown encoder 'libx264'|Automatic encoder selection failed/i.test(stderr)) {
    return `Esta compilación de ffmpeg no trae el códec de video H.264 (libx264), así que no puede escribir el MP4. Usá otro binario definiendo FFMPEG_PATH.\n\n${comando}`
  }
  if (/No such file or directory/i.test(stderr)) {
    const falta = /(\S+): No such file or directory/i.exec(stderr)
    return `Falta un archivo de entrada de la mezcla${falta ? `: ${falta[1]}` : ''}.\n\n${comando}`
  }
  if (/No space left on device/i.test(stderr)) {
    return `No queda espacio en disco para escribir el video.\n\n${comando}`
  }
  if (/Invalid data found when processing input/i.test(stderr)) {
    return `Uno de los archivos de entrada está cortado o no es un video válido.\n\n${comando}`
  }

  return `${error.message}\n\nComando:\n${comando}`
}

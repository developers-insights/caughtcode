/**
 * Lectura y escritura de WAV sin dependencias.
 *
 * Lo usa: los tres proveedores de TTS (para medir la duración exacta de lo que
 * devolvió el servicio) y `none.ts` (para fabricar silencio).
 *
 * Por qué existe: `ffmpeg-static` empaqueta **solo** el binario `ffmpeg`, no
 * `ffprobe`. Medir duración con ffmpeg implica spawnear un proceso y parsear
 * stderr. Para PCM sin comprimir la duración sale del encabezado con
 * aritmética de primaria, es exacta y es testeable sin tocar el disco.
 */

import { AUDIO_BITS_PER_SAMPLE, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from './types'

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Bytes de muestras, sin encabezados. */
  dataBytes: number
  /** Dónde empiezan las muestras dentro del archivo. */
  dataOffset: number
  durationMs: number
}

export class WavError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WavError'
  }
}

const ASCII_RIFF = 0x52494646 // "RIFF"
const ASCII_WAVE = 0x57415645 // "WAVE"

/**
 * Recorre los chunks del RIFF hasta encontrar `fmt ` y `data`.
 * No asume que estén pegados ni en orden: Azure intercala un chunk `LIST`.
 */
export function readWavInfo(buffer: Uint8Array): WavInfo {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 12) throw new WavError('El archivo es demasiado corto para ser un WAV.')
  if (buf.readUInt32BE(0) !== ASCII_RIFF) throw new WavError('No empieza con "RIFF": no es un WAV.')
  if (buf.readUInt32BE(8) !== ASCII_WAVE) throw new WavError('No es un RIFF de tipo "WAVE".')

  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataBytes = -1
  let dataOffset = -1

  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const declared = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    // Un chunk puede declarar más de lo que hay (grabaciones cortadas): acotamos.
    const size = Math.min(declared, Math.max(0, buf.length - body))

    if (id === 'fmt ') {
      if (size < 16) throw new WavError('El chunk "fmt " está incompleto.')
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataBytes = size
      dataOffset = body
    }

    // Los chunks van alineados a 2 bytes.
    offset = body + size + (size % 2)
  }

  if (!sampleRate || !channels || !bitsPerSample) {
    throw new WavError('El WAV no declara formato: falta el chunk "fmt ".')
  }
  if (dataBytes < 0) throw new WavError('El WAV no tiene chunk "data".')

  const bytesPerFrame = channels * (bitsPerSample / 8)
  const durationMs = bytesPerFrame > 0 ? (dataBytes / bytesPerFrame / sampleRate) * 1000 : 0

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    dataOffset,
    durationMs: Math.round(durationMs),
  }
}

/** Las muestras crudas, sin encabezados. */
export function extraerMuestras(buffer: Uint8Array): Buffer {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const info = readWavInfo(buf)
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes)
}

/** ¿Este WAV está en el formato canónico del pipeline (24 kHz, mono, 16 bits)? */
export function esFormatoCanonico(info: WavInfo): boolean {
  return (
    info.sampleRate === AUDIO_SAMPLE_RATE &&
    info.channels === AUDIO_CHANNELS &&
    info.bitsPerSample === AUDIO_BITS_PER_SAMPLE
  )
}

export function readWavDurationMs(buffer: Uint8Array): number {
  return readWavInfo(buffer).durationMs
}

export interface WavFormat {
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
}

/** Encabezado RIFF/WAVE PCM de 44 bytes para `dataBytes` de muestras. */
export function wavHeader(dataBytes: number, format: WavFormat = {}): Buffer {
  const sampleRate = format.sampleRate ?? AUDIO_SAMPLE_RATE
  const channels = format.channels ?? AUDIO_CHANNELS
  const bitsPerSample = format.bitsPerSample ?? AUDIO_BITS_PER_SAMPLE
  const bytesPerFrame = channels * (bitsPerSample / 8)

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // tamaño del chunk fmt
  header.writeUInt16LE(1, 20) // 1 = PCM sin comprimir
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28) // byte rate
  header.writeUInt16LE(bytesPerFrame, 32) // block align
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/** WAV de silencio exacto. Se usa con TTS_PROVIDER=none y como relleno. */
export function silenceWav(durationMs: number, format: WavFormat = {}): Buffer {
  const sampleRate = format.sampleRate ?? AUDIO_SAMPLE_RATE
  const channels = format.channels ?? AUDIO_CHANNELS
  const bitsPerSample = format.bitsPerSample ?? AUDIO_BITS_PER_SAMPLE
  const bytesPerFrame = channels * (bitsPerSample / 8)

  const frames = Math.max(0, Math.round((Math.max(0, durationMs) / 1000) * sampleRate))
  const dataBytes = frames * bytesPerFrame
  // PCM de 16 bits con signo: el silencio es cero, así que alloc ya alcanza.
  return Buffer.concat([wavHeader(dataBytes, format), Buffer.alloc(dataBytes)])
}

/**
 * Envuelve PCM crudo en un WAV. Google devuelve LINEAR16 ya con encabezado,
 * pero Azure puede devolver crudo según el formato pedido: normalizamos acá.
 */
export function ensureWav(bytes: Uint8Array, format: WavFormat = {}): Buffer {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length >= 12 && buf.readUInt32BE(0) === ASCII_RIFF) return buf
  return Buffer.concat([wavHeader(buf.length, format), buf])
}

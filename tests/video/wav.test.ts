import { describe, expect, it } from 'vitest'

import {
  esFormatoCanonico,
  ensureWav,
  extraerMuestras,
  readWavInfo,
  silenceWav,
  wavHeader,
} from '@/server/video/tts/wav'

describe('WAV', () => {
  it('mide la duración exacta desde el encabezado', () => {
    const info = readWavInfo(silenceWav(1_500))
    expect(info.durationMs).toBe(1_500)
    expect(info.sampleRate).toBe(24_000)
    expect(info.channels).toBe(1)
    expect(info.bitsPerSample).toBe(16)
  })

  it('el silencio de 0 ms no rompe', () => {
    expect(readWavInfo(silenceWav(0)).durationMs).toBe(0)
  })

  it('reconoce el formato canónico del pipeline', () => {
    expect(esFormatoCanonico(readWavInfo(silenceWav(100)))).toBe(true)
    const otro = Buffer.concat([
      wavHeader(4_000, { sampleRate: 44_100, channels: 2 }),
      Buffer.alloc(4_000),
    ])
    expect(esFormatoCanonico(readWavInfo(otro))).toBe(false)
  })

  it('encuentra el chunk data aunque haya chunks intercalados', () => {
    // Azure intercala un LIST entre fmt y data.
    const fmt = wavHeader(0).subarray(12, 36)
    const lista = Buffer.concat([
      Buffer.from('LIST'),
      buf32(10),
      Buffer.from('INFOhola12'),
    ])
    const muestras = Buffer.alloc(2_400) // 50 ms
    const cuerpo = Buffer.concat([fmt, lista, Buffer.from('data'), buf32(muestras.length), muestras])
    const archivo = Buffer.concat([
      Buffer.from('RIFF'),
      buf32(4 + cuerpo.length),
      Buffer.from('WAVE'),
      cuerpo,
    ])

    const info = readWavInfo(archivo)
    expect(info.dataBytes).toBe(2_400)
    expect(info.durationMs).toBe(50)
    expect(extraerMuestras(archivo)).toHaveLength(2_400)
  })

  it('tolera un chunk data que declara más de lo que hay', () => {
    const wav = silenceWav(1_000)
    const cortado = wav.subarray(0, wav.length - 1_000)
    expect(() => readWavInfo(cortado)).not.toThrow()
    expect(readWavInfo(cortado).durationMs).toBeLessThan(1_000)
  })

  it('envuelve PCM crudo y deja pasar un WAV ya armado', () => {
    const crudo = Buffer.alloc(4_800) // 100 ms
    expect(readWavInfo(ensureWav(crudo)).durationMs).toBe(100)
    const yaWav = silenceWav(200)
    expect(ensureWav(yaWav)).toEqual(yaWav)
  })

  it('rechaza lo que no es un WAV, con un mensaje entendible', () => {
    expect(() => readWavInfo(Buffer.from('no soy un wav en absoluto'))).toThrow(/RIFF/)
  })
})

function buf32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

import { describe, expect, it } from 'vitest'

import {
  construirTranscripcion,
  construirVtt,
  cuesDeGuion,
  cuesDeTramo,
  MAX_CARACTERES_POR_CUE,
  partirEnFrases,
  tiempoVtt,
} from '@/server/video/subtitles'

describe('corte en frases', () => {
  it('deja las frases cortas enteras', () => {
    expect(partirEnFrases('Entramos y salimos.')).toEqual(['Entramos y salimos.'])
  })

  it('ningún pedazo se pasa del largo legible', () => {
    const largo =
      'Nos registramos en tu app como un usuario más, sin ningún permiso especial, y desde esa cuenta pudimos pedirle a tu base de datos las filas que pertenecen a otra persona, que aparecieron completas en la pantalla.'
    for (const parte of partirEnFrases(largo)) {
      expect(parte.length).toBeLessThanOrEqual(MAX_CARACTERES_POR_CUE)
    }
  })

  it('no pierde ni inventa palabras', () => {
    const texto =
      'Probamos entrar. Después miramos los datos, que estaban abiertos, y los pudimos leer enteros sin ningún problema.'
    const juntas = partirEnFrases(texto).join(' ').replace(/\s+/g, ' ')
    expect(juntas).toBe(texto)
  })

  it('corta una oración larguísima sin puntuación', () => {
    const sinPuntos = 'palabra '.repeat(40).trim()
    const partes = partirEnFrases(sinPuntos)
    expect(partes.length).toBeGreaterThan(1)
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(MAX_CARACTERES_POR_CUE)
  })

  it('el texto vacío no produce nada', () => {
    expect(partirEnFrases('   ')).toEqual([])
  })
})

describe('tiempos', () => {
  it('el primer cue arranca cuando arranca la voz', () => {
    const cues = cuesDeTramo({ narration: 'Una. Dos.', vozStartMs: 5_000, audioMs: 4_000 })
    expect(cues[0].startMs).toBe(5_000)
  })

  it('el último cue termina cuando termina la voz', () => {
    const cues = cuesDeTramo({
      narration: 'Una frase. Otra frase distinta. Y una tercera para cerrar.',
      vozStartMs: 1_000,
      audioMs: 6_000,
    })
    expect(cues[cues.length - 1].endMs).toBe(7_000)
  })

  it('los cues no se superponen', () => {
    const cues = cuesDeGuion([
      { narration: 'Uno. Dos. Tres.', vozStartMs: 0, audioMs: 6_000 },
      { narration: 'Cuatro. Cinco.', vozStartMs: 10_000, audioMs: 4_000 },
    ])
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startMs).toBeGreaterThanOrEqual(cues[i - 1].endMs - 1)
    }
  })

  it('sin audio no hay subtítulo', () => {
    expect(cuesDeTramo({ narration: 'Algo.', vozStartMs: 0, audioMs: 0 })).toEqual([])
  })
})

describe('WebVTT', () => {
  it('formatea el tiempo como pide el estándar', () => {
    expect(tiempoVtt(0)).toBe('00:00:00.000')
    expect(tiempoVtt(65_432)).toBe('00:01:05.432')
    expect(tiempoVtt(3_600_000)).toBe('01:00:00.000')
  })

  it('arranca con la cabecera WEBVTT', () => {
    const vtt = construirVtt([{ startMs: 0, endMs: 1_000, text: 'Hola' }])
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000')
    expect(vtt).toContain('Hola')
  })
})

describe('transcripción', () => {
  it('junta la narración de todas las escenas', () => {
    const texto = construirTranscripcion([
      { narration: 'Primera.' },
      { narration: '  Segunda.  ' },
      { narration: '' },
    ])
    expect(texto).toBe('Primera.\n\nSegunda.')
  })
})

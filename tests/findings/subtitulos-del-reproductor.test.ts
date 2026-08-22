/**
 * La pista de subtítulos que el reproductor le entrega al navegador.
 *
 * El reproductor dibuja los subtítulos él mismo, pero eso solo existe para
 * quien mira nuestra capa de React. Un `<track>` WebVTT válido es lo único que
 * el navegador, el lector de pantalla y el reproductor nativo de iOS saben
 * leer. Si este archivo sale mal formado, el navegador **descarta el archivo
 * entero** y el video se queda sin subtítulos sin avisar: por eso se testea el
 * formato exacto, y no solo que la función devuelva algo.
 */

import { describe, expect, it } from 'vitest'
import { construirVtt, cuesDelGuion } from '@/components/findings/view'
import { VIDEOS_DEMO } from '@/components/findings/fixtures'
import type { VideoScript } from '@/lib/types/domain'

function guion(escenas: Array<{ id: string; durationMs: number; caption?: string; narration: string }>) {
  return {
    kind: 'finding',
    title: 'Prueba',
    scenes: escenas,
    totalDurationMs: escenas.reduce((a, e) => a + e.durationMs, 0),
  } as unknown as VideoScript
}

describe('construirVtt', () => {
  it('abre con la cabecera que exige el formato', () => {
    const vtt = construirVtt(cuesDelGuion(guion([{ id: 'a', durationMs: 2000, narration: 'Hola' }])))
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
  })

  it('escribe los tiempos en HH:MM:SS.mmm y encadenados', () => {
    const cues = cuesDelGuion(
      guion([
        { id: 'a', durationMs: 1500, narration: 'Primera' },
        { id: 'b', durationMs: 2500, narration: 'Segunda' },
      ]),
    )

    expect(construirVtt(cues)).toBe(
      'WEBVTT\n\n' +
        '1\n00:00:00.000 --> 00:00:01.500\nPrimera\n\n' +
        '2\n00:00:01.500 --> 00:00:04.000\nSegunda\n',
    )
  })

  it('pasa de la hora sin romper el formato', () => {
    const cues = cuesDelGuion(
      guion([
        { id: 'a', durationMs: 3_600_000, narration: 'Larga' },
        { id: 'b', durationMs: 1000, narration: 'Después' },
      ]),
    )
    expect(construirVtt(cues)).toContain('01:00:00.000 --> 01:00:01.000')
  })

  it('usa el texto en pantalla, que es más corto que la narración', () => {
    const cues = cuesDelGuion(
      guion([{ id: 'a', durationMs: 2000, caption: 'Corto', narration: 'La versión larga hablada' }]),
    )
    const vtt = construirVtt(cues)
    expect(vtt).toContain('Corto')
    expect(vtt).not.toContain('La versión larga hablada')
  })

  it('aplasta los saltos de línea: una línea en blanco cortaría el cue', () => {
    const cues = cuesDelGuion(
      guion([{ id: 'a', durationMs: 2000, caption: 'Dos\n\nrenglones', narration: 'x' }]),
    )
    const vtt = construirVtt(cues)
    expect(vtt).toContain('Dos renglones')
    expect(vtt.split('\n\n')).toHaveLength(2) // cabecera + un solo cue
  })

  it('saltea los cues vacíos o de duración cero en vez de emitirlos rotos', () => {
    const cues = cuesDelGuion(
      guion([
        { id: 'a', durationMs: 0, caption: 'Instantánea', narration: 'x' },
        { id: 'b', durationMs: 2000, caption: '   ', narration: ' ' },
        { id: 'c', durationMs: 1000, caption: 'Única válida', narration: 'y' },
      ]),
    )
    const vtt = construirVtt(cues)
    expect(vtt).toContain('Única válida')
    expect(vtt).not.toContain('Instantánea')
    expect(vtt.match(/-->/g)).toHaveLength(1)
    expect(vtt).toContain('1\n') // se renumera: el válido queda como cue 1
  })

  it('sin guion devuelve una pista vacía pero válida, no basura', () => {
    expect(construirVtt(cuesDelGuion(null))).toBe('WEBVTT\n')
  })

  it('el video de la demostración sale con subtítulos de verdad', () => {
    const demo = Object.values(VIDEOS_DEMO).find((v) => v.script)
    expect(demo, 'la demostración tiene que tener al menos un video con guion').toBeDefined()

    const vtt = construirVtt(cuesDelGuion(demo!.script))
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('-->')
  })

  it('sobrevive a un viaje por data URL, que es como lo consume el reproductor', () => {
    const vtt = construirVtt(cuesDelGuion(guion([{ id: 'a', durationMs: 2000, narration: 'Ñandú áéí' }])))
    const url = `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`
    expect(decodeURIComponent(url.slice('data:text/vtt;charset=utf-8,'.length))).toBe(vtt)
  })
})

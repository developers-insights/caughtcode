/**
 * Subtítulos: corte en frases, tiempos, WebVTT y transcripción.
 *
 * Lo usa: `render/page.ts` (los quema en el video), `index.ts` (escribe el
 * `.vtt` y el `.txt`) y los tests.
 *
 * Se generan tres cosas del mismo material y por razones distintas:
 *  - Quemados en el video: el clip se entiende sin sonido. Mucha gente lo va a
 *    mirar con el audio apagado.
 *  - `.vtt` aparte: accesibilidad y reproductores que ofrecen subtítulos.
 *  - Transcripción en texto: para que el hallazgo sea buscable y copiable.
 *
 * Módulo puro. Testeado en `tests/video/subtitles.test.ts`.
 */

/** Dos renglones de 42 caracteres: el límite de lectura cómoda en pantalla. */
export const MAX_CARACTERES_POR_CUE = 84

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

/**
 * Parte una narración en pedazos legibles.
 * Prioriza el corte en fin de oración; después en coma; recién al final corta
 * por palabra. Cortar a mitad de una idea se lee peor que un renglón desparejo.
 */
export function partirEnFrases(texto: string, maxChars = MAX_CARACTERES_POR_CUE): string[] {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  if (!limpio) return []
  if (limpio.length <= maxChars) return [limpio]

  const oraciones = limpio.match(/[^.!?…]+[.!?…]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [limpio]

  const salida: string[] = []
  for (const oracion of oraciones) {
    if (oracion.length <= maxChars) {
      salida.push(oracion)
      continue
    }
    for (const parte of partirPorComa(oracion, maxChars)) salida.push(parte)
  }
  return unirCortos(salida, maxChars)
}

function partirPorComa(oracion: string, maxChars: number): string[] {
  const trozos = oracion.split(/(?<=,)\s+/)
  const salida: string[] = []
  let actual = ''

  for (const trozo of trozos) {
    const candidato = actual ? `${actual} ${trozo}` : trozo
    if (candidato.length <= maxChars) {
      actual = candidato
      continue
    }
    if (actual) salida.push(actual)
    actual = trozo.length <= maxChars ? trozo : ''
    if (!actual) for (const p of partirPorPalabra(trozo, maxChars)) salida.push(p)
  }
  if (actual) salida.push(actual)
  return salida
}

function partirPorPalabra(texto: string, maxChars: number): string[] {
  const palabras = texto.split(' ')
  const salida: string[] = []
  let actual = ''
  for (const palabra of palabras) {
    const candidato = actual ? `${actual} ${palabra}` : palabra
    if (candidato.length <= maxChars) {
      actual = candidato
    } else {
      if (actual) salida.push(actual)
      actual = palabra
    }
  }
  if (actual) salida.push(actual)
  return salida
}

/** Junta pedazos muy cortos con el siguiente: un cue de tres palabras parpadea. */
function unirCortos(partes: string[], maxChars: number): string[] {
  const salida: string[] = []
  for (const parte of partes) {
    const previo = salida[salida.length - 1]
    if (previo && previo.length < 26 && `${previo} ${parte}`.length <= maxChars) {
      salida[salida.length - 1] = `${previo} ${parte}`
    } else {
      salida.push(parte)
    }
  }
  return salida
}

export interface TramoNarrado {
  narration: string
  /** Cuándo arranca la voz de esta escena, en ms desde el inicio del clip. */
  vozStartMs: number
  /** Cuánto dura la voz. */
  audioMs: number
}

/**
 * Reparte el tiempo de voz entre los cues, en proporción a los caracteres.
 * Es una aproximación: el locutor no habla a ritmo constante. Alcanza porque
 * los cues son cortos y el error se reparte; para sincronía por palabra haría
 * falta que el proveedor devuelva marcas de tiempo (Azure las tiene, se puede
 * mejorar después sin cambiar esta interfaz).
 */
export function cuesDeTramo(tramo: TramoNarrado, maxChars = MAX_CARACTERES_POR_CUE): Cue[] {
  const partes = partirEnFrases(tramo.narration, maxChars)
  if (partes.length === 0 || tramo.audioMs <= 0) return []

  const totalChars = partes.reduce((a, p) => a + p.length, 0) || 1
  const cues: Cue[] = []
  let cursor = tramo.vozStartMs

  partes.forEach((parte, i) => {
    const esUltima = i === partes.length - 1
    const porcion = Math.round((parte.length / totalChars) * tramo.audioMs)
    const fin = esUltima ? tramo.vozStartMs + tramo.audioMs : cursor + porcion
    cues.push({ startMs: Math.round(cursor), endMs: Math.round(Math.max(fin, cursor + 400)), text: parte })
    cursor = fin
  })

  return cues
}

export function cuesDeGuion(tramos: TramoNarrado[], maxChars = MAX_CARACTERES_POR_CUE): Cue[] {
  return tramos.flatMap((t) => cuesDeTramo(t, maxChars))
}

/* ── Formatos de salida ───────────────────────────────────────────────── */

export function tiempoVtt(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const cs = total % 1000
  const dos = (n: number) => String(n).padStart(2, '0')
  return `${dos(h)}:${dos(m)}:${dos(s)}.${String(cs).padStart(3, '0')}`
}

export function construirVtt(cues: Cue[]): string {
  const cuerpo = cues
    .map((c, i) => `${i + 1}\n${tiempoVtt(c.startMs)} --> ${tiempoVtt(c.endMs)}\n${c.text}`)
    .join('\n\n')
  return `WEBVTT\n\n${cuerpo}\n`
}

/** Transcripción corrida, para que el hallazgo sea buscable. */
export function construirTranscripcion(tramos: Array<{ narration: string }>): string {
  return tramos
    .map((t) => t.narration.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}

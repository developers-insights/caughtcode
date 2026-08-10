/**
 * Prosodia: convierte una frase de narración en SSML con pausas explícitas y
 * ritmo más lento que el default.
 *
 * Lo usa: `src/server/video/tts/index.ts` antes de llamar a cualquier proveedor.
 *
 * Por qué importa (D10 / MEMORY.md): el problema de la voz sintética no es que
 * suene sintética — es que suena apurada. Hay un caso documentado de watch time
 * de 9 s a 24 s cambiando solo el ritmo y las pausas, con el mismo motor. Así
 * que las pausas no son decoración: son la mitad del entregable.
 *
 * Módulo puro: sin red, sin disco. Testeado en `tests/video/ssml.test.ts`.
 */

import type { SsmlDialect } from './types'

/** Ritmo relativo al default del proveedor. -12% entra en la banda 10-15% de D10. */
export const RITMO_LENTO_PCT = -12

/** Duración de cada pausa, por signo de puntuación. */
export const PAUSA_MS = {
  /** Punto, cierre de exclamación o de pregunta, puntos suspensivos. */
  oracion: 380,
  /** Dos puntos y punto y coma: anuncian lo que viene, piden aire. */
  anuncio: 300,
  /** Coma: respiración corta, no silencio. */
  clausula: 180,
} as const

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

export function escaparXml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/** Normaliza espacios y saltos de línea a un solo espacio. */
export function normalizarTexto(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim()
}

function etiquetaPausa(ms: number): string {
  return `<break time="${ms}ms"/>`
}

/**
 * Inserta `<break/>` después de cada signo de puntuación que corta la frase.
 * No agrega pausa al final: el aire de cierre lo pone la escena (`COLA_MS` en
 * `timing.ts`), no la voz. Así el silencio final no se paga como caracteres.
 */
export function fraseoConPausas(texto: string): string {
  const limpio = escaparXml(normalizarTexto(texto))
  return limpio
    .replace(/([.!?…])(\s+)/g, (_m, signo: string) => `${signo}${etiquetaPausa(PAUSA_MS.oracion)} `)
    .replace(/([:;])(\s+)/g, (_m, signo: string) => `${signo}${etiquetaPausa(PAUSA_MS.anuncio)} `)
    .replace(/(,)(\s+)/g, (_m, signo: string) => `${signo}${etiquetaPausa(PAUSA_MS.clausula)} `)
}

export interface SsmlOptions {
  dialect: SsmlDialect
  voice: string
  /** Idioma. Rioplatense por default: es-AR, no "español neutro". */
  lang?: string
  /** Ritmo en porcentaje relativo. Negativo = más lento. */
  ritmoPct?: number
}

/**
 * Azure quiere el nombre de la voz dentro del SSML; Google lo recibe aparte en
 * el cuerpo del request y **rechaza** un `<voice>` dentro del SSML. De ahí que
 * haya dos dialectos y no uno.
 */
export function construirSsml(texto: string, opts: SsmlOptions): string {
  const lang = opts.lang ?? 'es-AR'
  const ritmo = opts.ritmoPct ?? RITMO_LENTO_PCT
  const cuerpo = fraseoConPausas(texto)

  if (opts.dialect === 'google') {
    // Google expresa el ritmo como porcentaje absoluto sobre el default.
    const rate = `${Math.round((100 + ritmo) * 100) / 100}%`
    return `<speak><prosody rate="${rate}">${cuerpo}</prosody></speak>`
  }

  const rate = `${ritmo > 0 ? '+' : ''}${ritmo}%`
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${escaparXml(opts.voice)}">` +
    `<prosody rate="${rate}">${cuerpo}</prosody>` +
    `</voice></speak>`
  )
}

/**
 * Caracteres que factura el proveedor: el texto hablado, sin etiquetas.
 * Azure y Google facturan por caracteres del SSML en algunos planes; medimos
 * el texto porque es el número estable y el que podemos comparar entre motores.
 */
export function caracteresHablados(ssml: string): number {
  return desarmarSsml(ssml).texto.length
}

export interface SsmlDesarmado {
  /** Solo el texto que se va a pronunciar. */
  texto: string
  /** Milisegundos totales declarados en `<break/>`. */
  pausasMs: number
}

const RE_BREAK = /<break\s+time="(\d+)ms"\s*\/>/g

export function desarmarSsml(ssml: string): SsmlDesarmado {
  let pausasMs = 0
  for (const m of ssml.matchAll(RE_BREAK)) pausasMs += Number(m[1])

  const texto = ssml
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

  return { texto, pausasMs }
}

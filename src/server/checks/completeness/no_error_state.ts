/**
 * Errores que se descartan en silencio.
 *
 * Dos formas del mismo problema:
 *   1. un `catch` vacío, o que solo escribe en la consola — para quien usa la
 *      app, el botón no hace nada
 *   2. una ruta sin pantalla de error, así que un fallo inesperado se lleva
 *      puesta la pantalla entera
 *
 * El `catch` que solo hace `console.log` cuenta como vacío a propósito: el
 * usuario no ve la consola.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba, lineaEn } from '../lib/files'

/** `catch { }`, `catch (e) { }` y `catch (e) { console.log(e) }`. */
const CATCH = /\bcatch\s*(?:\(\s*[\w$]*\s*(?::\s*[^)]+)?\)\s*)?\{/g

/** Lo único que hay adentro es un registro en consola. */
const SOLO_CONSOLA =
  /^\s*(?:\/\/[^\n]*\n\s*)*console\s*\.\s*(?:log|error|warn|info|debug)\s*\([^;]*\)\s*;?\s*$/

const MAX_POR_ARCHIVO = 2

export const noErrorState = defineCheck({
  id: 'cmp.no_error_state',
  pillar: 'completeness',
  name: 'no-error-state',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue

      let emitidos = 0

      for (const { index, linea, lineaTexto } of coincidencias(archivo.text, CATCH)) {
        if (emitidos >= MAX_POR_ARCHIVO) break

        const apertura = index + archivo.text.slice(index).indexOf('{')
        const bloque = cuerpoDelBloque(archivo.text, apertura)
        if (bloque === null) continue

        const vacio = bloque.cuerpo.trim() === ''
        const soloConsola = SOLO_CONSOLA.test(bloque.cuerpo)
        if (!vacio && !soloConsola) continue

        emitidos++
        const lineaFinal = lineaEn(archivo.text, bloque.fin)
        drafts.push(
          draftFrom(
            'cmp.no_error_state',
            { archivo: archivo.path, linea },
            [
              evidenciaCodigo(
                archivo.path,
                linea,
                recortar(
                  vacio
                    ? `${lineaTexto.trim()}   ← el error entra acá y no sale nada`
                    : lineaTexto.trim(),
                ),
                lineaFinal > linea ? lineaFinal : undefined,
              ),
            ],
          ),
        )
        ctx.log(`cmp.no_error_state: ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

/**
 * Contenido entre la llave que abre en `desde` y su pareja, más la posición de
 * la llave que cierra.
 *
 * Cuenta llaves respetando textos y comentarios: un `{` dentro de un string no
 * abre nada, y contarlo desalinearía todo el bloque — con el resultado de citar
 * una línea equivocada, que es peor que no citar ninguna.
 */
function cuerpoDelBloque(
  texto: string,
  desde: number,
): { cuerpo: string; fin: number } | null {
  if (texto[desde] !== '{') return null

  let profundidad = 0
  let i = desde
  let enTexto: string | null = null
  let enComentarioLinea = false
  let enComentarioBloque = false

  for (; i < texto.length; i++) {
    const c = texto[i]!
    const siguiente = texto[i + 1]

    if (enComentarioLinea) {
      if (c === '\n') enComentarioLinea = false
      continue
    }
    if (enComentarioBloque) {
      if (c === '*' && siguiente === '/') {
        enComentarioBloque = false
        i++
      }
      continue
    }
    if (enTexto) {
      if (c === '\\') i++
      else if (c === enTexto) enTexto = null
      continue
    }

    if (c === '/' && siguiente === '/') {
      enComentarioLinea = true
      i++
      continue
    }
    if (c === '/' && siguiente === '*') {
      enComentarioBloque = true
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      enTexto = c
      continue
    }
    if (c === '{') profundidad++
    else if (c === '}') {
      profundidad--
      if (profundidad === 0) return { cuerpo: texto.slice(desde + 1, i), fin: i }
    }
  }

  return null
}

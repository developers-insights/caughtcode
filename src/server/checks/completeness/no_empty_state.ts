/**
 * Lista sin caso "todavía no hay nada".
 *
 * El primer minuto decide si alguien se queda, y un usuario nuevo entra
 * siempre con cero elementos. Se busca un `.map` que dibuje algo y se comprueba
 * que en el archivo exista alguna rama para la lista vacía.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba } from '../lib/files'
import { rutaDeArchivo } from './no_loading_state'

/** `{lista.map(...)}` dentro de JSX. */
const MAP_EN_JSX = /\{\s*([\w$.?]+)\s*(?:\?\.)?\.\s*map\s*\(/g

/** Alguna rama para "no hay nada". */
const CONTEMPLA_VACIO =
  /\.length\s*(?:===?|>|<|!==?)\s*0|\.length\s*\?|!\w+\.length|\.length\s*&&|\bisEmpty\b|\bempty\b|\bEmptyState\b|\bsin\s+resultados\b|\btodav[ií]a\s+no\b|\bno\s+hay\b|\bnothing\b|\bnada\s+(?:ac[aá]|todav[ií]a)\b/i

const MAX_POR_ARCHIVO = 1

export const noEmptyState = defineCheck({
  id: 'cmp.no_empty_state',
  pillar: 'completeness',
  name: 'no-empty-state',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue
      if (CONTEMPLA_VACIO.test(archivo.text)) continue

      let emitidos = 0

      for (const { match, linea, lineaTexto } of coincidencias(archivo.text, MAP_EN_JSX)) {
        if (emitidos >= MAX_POR_ARCHIVO) break

        const coleccion = match[1] ?? ''
        // Un map sobre una constante escrita a mano siempre tiene elementos.
        if (/^\[/.test(coleccion)) continue

        emitidos++
        const ruta = rutaDeArchivo(ctx.index.routes, archivo.path)
        drafts.push(
          draftFrom(
            'cmp.no_empty_state',
            { ruta, archivo: archivo.path, linea },
            [evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim()))],
          ),
        )
        ctx.log(`cmp.no_empty_state: ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

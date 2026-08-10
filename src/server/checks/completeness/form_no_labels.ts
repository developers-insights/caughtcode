/**
 * Campos de formulario sin nombre.
 *
 * No es un juicio de diseño: es un campo que, para quien usa lector de
 * pantalla, no tiene nombre, y que para todos los demás pierde su indicación
 * apenas se empieza a escribir. Es medible y objetivo — que es lo único que se
 * reporta en este pilar (D6).
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba, esMarcado } from '../lib/files'
import { rutaDeArchivo } from './no_loading_state'

const CAMPO = /<(input|textarea|select)\b([^>]*)>/gi

/** Tipos que no llevan etiqueta visible por naturaleza. */
const TIPO_SIN_ETIQUETA = /type\s*=\s*['"{]?\s*(hidden|submit|button|reset|image)\b/i

const TIENE_NOMBRE_ACCESIBLE = /\b(aria-label|aria-labelledby|title)\s*=/i

const MAX_POR_ARCHIVO = 1

export const formNoLabels = defineCheck({
  id: 'cmp.form_no_labels',
  pillar: 'completeness',
  name: 'form-no-labels',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path) && !esMarcado(archivo.path)) continue
      if (!/<(?:input|textarea|select)\b/i.test(archivo.text)) continue

      const idsConEtiqueta = etiquetasDelArchivo(archivo.text)
      let emitidos = 0

      for (const { match, linea, lineaTexto } of coincidencias(archivo.text, CAMPO)) {
        if (emitidos >= MAX_POR_ARCHIVO) break

        const atributos = match[2] ?? ''
        if (TIPO_SIN_ETIQUETA.test(atributos)) continue
        if (TIENE_NOMBRE_ACCESIBLE.test(atributos)) continue

        // Un `id` con su `<label htmlFor>` correspondiente resuelve el problema.
        const id = /\bid\s*=\s*['"]([^'"]+)['"]/.exec(atributos)?.[1]
        if (id && idsConEtiqueta.has(id)) continue

        // Un campo envuelto en <label> tampoco necesita nada más.
        if (envueltoEnEtiqueta(archivo.text, match.index ?? 0)) continue

        emitidos++
        const ruta = rutaDeArchivo(ctx.index.routes, archivo.path)
        drafts.push(
          draftFrom(
            'cmp.form_no_labels',
            { ruta, archivo: archivo.path, linea },
            [evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim()))],
          ),
        )
        ctx.log(`cmp.form_no_labels: ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

/** Ids que ya tienen un `<label>` apuntándoles. */
function etiquetasDelArchivo(texto: string): Set<string> {
  const ids = new Set<string>()
  for (const match of texto.matchAll(/<label\b[^>]*\b(?:htmlFor|for)\s*=\s*['"{]?([^'"}\s>]+)/gi)) {
    ids.add(match[1]!)
  }
  return ids
}

/** `<label> … <input/> … </label>`: se mira hacia atrás sin cruzar otro cierre. */
function envueltoEnEtiqueta(texto: string, posicion: number): boolean {
  const ventana = texto.slice(Math.max(0, posicion - 500), posicion)
  const abre = ventana.lastIndexOf('<label')
  if (abre === -1) return false
  const cierra = ventana.lastIndexOf('</label>')
  return cierra < abre
}

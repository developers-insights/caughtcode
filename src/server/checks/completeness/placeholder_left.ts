/**
 * Texto de relleno que quedó sin reemplazar.
 *
 * Solo lo que **se ve en pantalla**: texto entre etiquetas JSX o dentro de un
 * atributo visible. Un `// TODO` en un comentario no es esto — de eso se ocupa
 * el escaneo de comentarios, y mezclarlos llenaría el reporte de ruido.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba, esMarcado } from '../lib/files'
import { rutaDeArchivo } from './no_loading_state'

const RELLENO =
  /\b(lorem\s+ipsum|dolor\s+sit\s+amet|consectetur\s+adipiscing|tu\s+texto\s+ac[aá]|texto\s+de\s+ejemplo|your\s+text\s+here|coming\s+soon|pr[oó]ximamente\s+aqu[ií]|placeholder\s+text|insert\s+\w+\s+here|coloc[aá]\s+ac[aá]|coming\s+up|coming\s+soon!|tbd|to\s+be\s+determined)\b|\[(?:nombre|name|empresa|company|producto|product|tu\s+\w+|your\s+\w+)\]|\bexample\.com\b|\bejemplo\.com\b|\btest@test\.\w+\b|\bfoo\s+bar\b|\blorem\b/gi

/** Ese `TODO`/`FIXME` está dentro de un comentario, no en pantalla. */
function enComentario(lineaTexto: string, columna: number): boolean {
  const antes = lineaTexto.slice(0, columna)
  return antes.includes('//') || antes.includes('/*') || antes.includes('<!--') || antes.trimStart().startsWith('*')
}

/** Está en un texto que el usuario ve: JSX, atributo de texto o marcado. */
function esVisible(lineaTexto: string, columna: number): boolean {
  const antes = lineaTexto.slice(0, columna)
  if (/>\s*[^<]*$/.test(antes)) return true // texto entre etiquetas
  if (/\b(?:title|label|placeholder|alt|aria-label|heading|subtitle|description|content|text|children)\s*=\s*["'{][^"']*$/i.test(antes)) {
    return true
  }
  if (/^\s*(?:const|let|var)?\s*\w*\s*[:=]\s*["'`][^"'`]*$/.test(antes)) return true
  return false
}

const MAX_POR_ARCHIVO = 1

export const placeholderLeft = defineCheck({
  id: 'cmp.placeholder_left',
  pillar: 'completeness',
  name: 'placeholder-left',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path) && !esMarcado(archivo.path)) continue
      // Los archivos de ejemplo existen justamente para tener texto de ejemplo.
      if (/(readme|changelog|license|\.md$|\.mdx$|\.example)/i.test(archivo.path)) continue

      let emitidos = 0

      for (const { match, linea, lineaTexto, index } of coincidencias(archivo.text, RELLENO)) {
        if (emitidos >= MAX_POR_ARCHIVO) break

        const inicioLinea = archivo.text.lastIndexOf('\n', index - 1) + 1
        const columna = index - inicioLinea

        if (enComentario(lineaTexto, columna)) continue
        if (!esVisible(lineaTexto, columna)) continue

        emitidos++
        const ruta = rutaDeArchivo(ctx.index.routes, archivo.path)
        drafts.push(
          draftFrom(
            'cmp.placeholder_left',
            {
              archivo: archivo.path,
              linea,
              texto: recortar(match[0].trim(), 60),
              ruta,
            },
            [evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim()))],
          ),
        )
        ctx.log(`cmp.placeholder_left: "${match[0]}" en ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

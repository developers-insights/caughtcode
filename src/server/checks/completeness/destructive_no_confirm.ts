/**
 * Botón que borra sin preguntar.
 *
 * Se busca el manejador de clic que llama a algo destructivo y se comprueba que
 * no haya confirmación cerca. "Cerca" = en el mismo archivo, porque el diálogo
 * casi siempre vive al lado del botón que lo dispara.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba } from '../lib/files'

/** `onClick={...borrar...}` en cualquiera de sus formas. */
const CLIC_DESTRUCTIVO =
  /\bon(?:Click|Press|Submit|Tap)\s*=\s*\{?\s*(?:\(\s*\)\s*=>\s*)?(?:async\s*\(\s*\)\s*=>\s*)?([A-Za-z_$][\w$]*(?:\s*\.\s*[\w$]+)*)\s*[\s(}]/g

/**
 * Verbos destructivos. Se comparan contra **cada palabra** del nombre del
 * manejador, no contra el nombre entero: `handleDeleteProject` no tiene ningún
 * límite de palabra alrededor de "Delete", así que un `\bdelete\b` no lo
 * encuentra nunca. Y `handleDeleteProject` es exactamente cómo se llaman estos
 * manejadores en el código que audita este producto.
 */
const VERBOS_DESTRUCTIVOS = new Set([
  'delete',
  'remove',
  'destroy',
  'drop',
  'wipe',
  'clear',
  'purge',
  'cancel',
  'revoke',
  'borrar',
  'eliminar',
  'quitar',
  'cancelar',
  'anular',
  'vaciar',
  'desactivar',
])

/**
 * Funciones que llevan un verbo destructivo y no borran nada del usuario.
 * Sin esta lista, `removeEventListener` sería un hallazgo crítico inventado.
 */
const FALSOS_DESTRUCTIVOS =
  /^(?:remove|clear|cancel)(?:EventListener|Child|Item|Attribute|Class|Timeout|Interval|AnimationFrame|Immediate|Focus|Selection|Errors?|Filters?|Search|Query|Form|Input|State)$/i

/** Parte `handleDeleteProject` / `handle_delete_project` en palabras sueltas. */
export function palabrasDe(nombre: string): string[] {
  return nombre
    .replace(/^.*\./, '') // `svc.deleteRow` → `deleteRow`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function pareceDestructivo(nombre: string): boolean {
  const solo = nombre.replace(/^.*\./, '')
  if (FALSOS_DESTRUCTIVOS.test(solo)) return false
  return palabrasDe(nombre).some((palabra) => VERBOS_DESTRUCTIVOS.has(palabra))
}

/** Cualquier forma de confirmar antes de ejecutar. */
const HAY_CONFIRMACION =
  /\b(?:window\.confirm|confirm\s*\(|AlertDialog|ConfirmDialog|ConfirmModal|Confirmation|useConfirm|showConfirm|¿?[Ee]st[aá]s?\s+seguro|are\s+you\s+sure|no\s+se\s+puede\s+deshacer|cannot\s+be\s+undone|Dialog[\s\S]{0,40}Trigger|AlertDialogAction)\b/

/** Texto visible del botón, para poder nombrarlo en el hallazgo. */
const ETIQUETA = />\s*([^<>{}\n]{2,40}?)\s*</

export const destructiveNoConfirm = defineCheck({
  id: 'cmp.destructive_no_confirm',
  pillar: 'completeness',
  name: 'destructive-no-confirm',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue
      if (HAY_CONFIRMACION.test(archivo.text)) continue

      const vistas = new Set<number>()

      for (const { match, linea, lineaTexto, index } of coincidencias(
        archivo.text,
        CLIC_DESTRUCTIVO,
      )) {
        if (vistas.has(linea)) continue

        const manejador = match[1] ?? ''
        if (!pareceDestructivo(manejador)) continue

        vistas.add(linea)

        const boton = etiquetaDelBoton(archivo.text, index) ?? nombreLegible(manejador)

        drafts.push(
          draftFrom(
            'cmp.destructive_no_confirm',
            { boton, archivo: archivo.path, linea },
            [evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim()))],
          ),
        )
        ctx.log(`cmp.destructive_no_confirm: "${boton}" en ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

/** El texto entre `>` y `<` justo después del atributo. */
function etiquetaDelBoton(texto: string, desde: number): string | null {
  const ventana = texto.slice(desde, desde + 400)
  const match = ETIQUETA.exec(ventana)
  if (!match) return null
  const etiqueta = match[1]!.trim()
  if (etiqueta.length < 2) return null
  if (/^[{}\s]*$/.test(etiqueta)) return null
  return etiqueta
}

/** `handleDeleteProject` → "Eliminar". Último recurso, para no dejar el hueco vacío. */
function nombreLegible(manejador: string): string {
  const palabras = palabrasDe(manejador)
  if (palabras.some((p) => ['cancel', 'cancelar', 'anular'].includes(p))) return 'Cancelar'
  if (palabras.some((p) => ['clear', 'vaciar', 'wipe', 'purge'].includes(p))) return 'Vaciar'
  return 'Eliminar'
}

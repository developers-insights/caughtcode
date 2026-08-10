/**
 * Formulario que no se valida en el servidor.
 *
 * La validación del navegador no cuenta y no es una opinión: se saltea con las
 * herramientas de desarrollo en dos clics, o mandando el pedido directo. Lo que
 * se busca es que el lado que recibe los datos los revise antes de guardarlos.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba } from '../lib/files'
import { rutaDeArchivo } from './no_loading_state'

/** Recibe datos de afuera. */
const RECIBE_DATOS =
  /\bformData\s*\.\s*get\s*\(|\bawait\s+(?:req|request)\s*\.\s*json\s*\(\)|\bawait\s+(?:req|request)\s*\.\s*formData\s*\(\)|\bFormData\b/g

/** Los valida con un esquema antes de usarlos. */
const VALIDA =
  /\b(?:z\s*\.\s*object|\.safeParse\s*\(|\.parse\s*\(|zodResolver|valibot|\bv\s*\.\s*object|yup\s*\.\s*object|\.validate\s*\(|superstruct|typia|ajv|assertValid)\b/

/** Los guarda en algún lado. Sin esto, validar da igual. */
const GUARDA =
  /\b(?:insert|update|upsert|create|createMany|save|set|add|delete)\s*\(|\bfrom\s*\(\s*['"][\w.]+['"]\s*\)/

export const formNoValidation = defineCheck({
  id: 'cmp.form_no_validation',
  pillar: 'completeness',
  name: 'form-no-validation',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue

      const esServidor =
        /^\s*['"]use server['"]/.test(archivo.text) ||
        /(^|\/)route\.[jt]sx?$/.test(archivo.path) ||
        /(^|\/)(actions?|server)\//.test(archivo.path) ||
        /(^|\/)pages\/api\//.test(archivo.path)
      if (!esServidor) continue

      const recepcion = [...coincidencias(archivo.text, RECIBE_DATOS)][0]
      if (!recepcion) continue
      if (VALIDA.test(archivo.text)) continue
      if (!GUARDA.test(archivo.text)) continue

      const ruta = rutaDeArchivo(ctx.index.routes, archivo.path)
      drafts.push(
        draftFrom(
          'cmp.form_no_validation',
          { ruta, archivo: archivo.path, linea: recepcion.linea },
          [evidenciaCodigo(archivo.path, recepcion.linea, recortar(recepcion.lineaTexto.trim()))],
        ),
      )
      ctx.log(`cmp.form_no_validation: ${ruta} (${archivo.path}:${recepcion.linea})`)
    }

    return drafts
  },
})

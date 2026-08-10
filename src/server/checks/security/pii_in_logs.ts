/**
 * Datos personales escritos en el registro del servidor.
 *
 * Se busca el objeto entero o el campo personal, no la palabra suelta:
 * `console.log('email enviado')` no es un hallazgo, `console.log(user)` sí.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba } from '../lib/files'

const LLAMADA_REGISTRO =
  /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|logger\s*\.\s*(?:log|info|warn|error|debug)|log\s*\.\s*(?:info|warn|error|debug))\s*\(([^;\n]{0,300})/g

/** Campos personales pasados como variable, no como texto fijo. */
const CAMPO_PERSONAL =
  /\b(?:\w+\s*\.\s*)?(?:email|e_?mail|correo|phone|telefono|teléfono|celular|dni|cuil|cuit|nif|ssn|social_?security|passport|pasaporte|card|tarjeta|credit_?card|card_?number|cvv|iban|address|direccion|dirección|birth_?date|fecha_?nacimiento|full_?name|nombre_?completo|password|contrasena|contraseña)\b/i

/** El objeto entero de una persona o de un pedido. */
const OBJETO_COMPLETO =
  /(?:^|[(,\s])(?:user|usuario|profile|perfil|customer|cliente|account|cuenta|member|patient|paciente|session|req\.body|request\.body|body|formData|payload|data)(?:\s*[,)]|\s*$)/

export const piiInLogs = defineCheck({
  id: 'sec.pii_in_logs',
  pillar: 'security',
  name: 'pii-in-logs',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path)) continue

      const vistas = new Set<number>()

      for (const { match, linea, lineaTexto } of coincidencias(archivo.text, LLAMADA_REGISTRO)) {
        if (vistas.has(linea)) continue

        const argumentos = match[1] ?? ''
        // Solo texto fijo: no hay dato de nadie.
        const sinTextos = argumentos.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
        if (sinTextos.trim().length === 0) continue

        const tieneCampo = CAMPO_PERSONAL.test(sinTextos)
        const tieneObjeto = OBJETO_COMPLETO.test(sinTextos)
        if (!tieneCampo && !tieneObjeto) continue

        vistas.add(linea)
        drafts.push(
          draftFrom(
            'sec.pii_in_logs',
            { archivo: archivo.path, linea },
            [evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim()))],
            { confidence: tieneCampo ? 'likely' : 'to_review' },
          ),
        )
        ctx.log(`sec.pii_in_logs: ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

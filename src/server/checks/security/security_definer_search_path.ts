/**
 * Función con permisos de administrador sin `search_path` fijo.
 *
 * Vía conocida de escalada de privilegios: la función corre como su creador,
 * pero resuelve los nombres de tabla con el `search_path` de quien la llama.
 * Un usuario común crea `mi_esquema.usuarios`, se pone ese esquema adelante, y
 * la función privilegiada termina operando sobre su tabla.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaBase } from '../lib/context'
import { esEsquemaDelUsuario } from './_esquema'

export const securityDefinerSearchPath = defineCheck({
  id: 'sec.security_definer_search_path',
  pillar: 'security',
  name: 'security-definer-search-path',
  requires: ['database'],
  async run(ctx): Promise<FindingDraft[]> {
    const drafts: FindingDraft[] = []

    for (const funcion of ctx.index.dbSchema.functions) {
      if (!funcion.securityDefiner) continue
      if (!esEsquemaDelUsuario(funcion.schema)) continue
      // Con search_path fijo (aunque sea vacío) el problema no existe.
      if (funcion.searchPath !== undefined && funcion.searchPath !== null) continue

      const nombre = `${funcion.schema}.${funcion.name}`
      drafts.push(
        draftFrom(
          'sec.security_definer_search_path',
          { funcion: funcion.name },
          [
            evidenciaBase(
              nombre,
              'La función corre con los permisos de quien la creó y no fija el orden en el que busca las tablas.',
            ),
          ],
        ),
      )
    }

    return drafts
  },
})

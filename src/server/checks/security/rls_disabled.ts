/**
 * Tabla sin ninguna regla de acceso.
 *
 * El más simple de los tres de reglas de acceso, y el más grave: no hay nada
 * que interpretar. `relrowsecurity = false` significa que la tabla se lee
 * entera con la llave pública que tu app publica en el navegador.
 */

import { defineCheck, draftFrom, evidenciaBase } from '../lib/context'
import type { FindingDraft } from '@/lib/types/domain'
import { tablasPublicas } from './_esquema'

export const rlsDisabled = defineCheck({
  id: 'sec.rls_disabled',
  pillar: 'security',
  name: 'rls-disabled',
  requires: ['database'],
  async run(ctx): Promise<FindingDraft[]> {
    const drafts: FindingDraft[] = []

    for (const tabla of tablasPublicas(ctx.index.dbSchema)) {
      if (tabla.rlsEnabled) continue

      const nombre = `${tabla.schema}.${tabla.name}`
      const columnas = tabla.columns.length
      drafts.push(
        draftFrom(
          'sec.rls_disabled',
          { tabla: tabla.name },
          [
            evidenciaBase(
              nombre,
              `La tabla no tiene activadas las reglas que definen quién puede ver qué. ` +
                `Tiene ${columnas} ${columnas === 1 ? 'columna' : 'columnas'} y ` +
                `${tabla.policies.length === 0 ? 'ninguna regla escrita' : `${tabla.policies.length} reglas escritas que no se aplican porque están desactivadas`}.`,
            ),
          ],
        ),
      )
      ctx.log(`sec.rls_disabled: ${nombre}`)
    }

    return drafts
  },
})

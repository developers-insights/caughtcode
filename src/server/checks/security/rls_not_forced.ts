/**
 * Reglas activadas pero no forzadas.
 *
 * Diferencia sutil y real: `enable row level security` no aplica al dueño de la
 * tabla. Cualquier función con permisos elevados —y en un proyecto de Supabase
 * hay varias— pasa por encima. `force` es lo que cierra esa puerta.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaBase } from '../lib/context'
import { tablasPublicas } from './_esquema'

export const rlsNotForced = defineCheck({
  id: 'sec.rls_not_forced',
  pillar: 'security',
  name: 'rls-not-forced',
  requires: ['database'],
  async run(ctx): Promise<FindingDraft[]> {
    const drafts: FindingDraft[] = []

    for (const tabla of tablasPublicas(ctx.index.dbSchema)) {
      if (!tabla.rlsEnabled) continue // sin reglas activadas, esto no aplica
      if (tabla.rlsForced) continue

      drafts.push(
        draftFrom(
          'sec.rls_not_forced',
          { tabla: tabla.name },
          [
            evidenciaBase(
              `${tabla.schema}.${tabla.name}`,
              `Las reglas están activadas pero no forzadas. ` +
                `Tiene ${tabla.policies.length} ${tabla.policies.length === 1 ? 'regla escrita' : 'reglas escritas'}, ` +
                `y el dueño de la tabla o una función con permisos elevados las ignora por completo.`,
            ),
          ],
        ),
      )
    }

    return drafts
  },
})

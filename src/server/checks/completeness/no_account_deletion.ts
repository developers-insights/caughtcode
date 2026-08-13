/**
 * No se puede borrar la cuenta.
 *
 * El hallazgo estrella del producto (D5): aparece en los tres pilares, es
 * binario, no admite interpretación legal, y la consecuencia se entiende sin
 * explicar nada — te rechazan la app.
 *
 * Este es el del pilar de completitud (falta un flujo). El de tienda vive en
 * `store_hygiene/no_account_deletion.ts` y el motor los une en uno solo.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck } from '../lib/context'
import { chequearFlujoFaltante } from './_flujos'

export const noAccountDeletion = defineCheck({
  id: 'cmp.no_account_deletion',
  pillar: 'completeness',
  name: 'no-account-deletion',
  requires: ['code', 'deployed_app', 'browser_run'],
  async run(ctx): Promise<FindingDraft[]> {
    return chequearFlujoFaltante(ctx, {
      catalogId: 'cmp.no_account_deletion',
      taskId: 'delete_account',
      pantallaEsperada: /(cuenta|account|ajustes|settings|configuracion|configuración|perfil|profile)\/.*\.(tsx|jsx|vue|svelte)$/i,
      senalEnCodigo: /\b(?:auth\.admin\.deleteUser|deleteUser\s*\(|delete[-_ ]?account|eliminar[-_ ]?cuenta|borrar[-_ ]?cuenta)\b/i,
      leyenda: 'Entramos a la sección de cuenta y recorrimos todas las opciones: no hay ninguna para eliminarla.',
    })
  },
})

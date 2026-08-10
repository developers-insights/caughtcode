/**
 * Borrado de cuenta, visto desde la tienda.
 *
 * Es el mismo hecho que `cmp.no_account_deletion` con otra consecuencia: allá
 * es un flujo que falta, acá es un rechazo directo en la revisión. Los dos se
 * emiten y el motor los une quedándose con uno solo (ver `runner.ts`), porque
 * mostrarle al usuario dos tarjetas del mismo problema es exactamente el ruido
 * que D15 manda a evitar.
 *
 * El dato duro que hace fuerte a este hallazgo: App Store lo exige desde junio
 * de 2022 (Guideline 5.1.1 v) y Google Play desde diciembre de 2023. No es
 * interpretación de ninguna ley — es la regla escrita de las dos tiendas.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck } from '../lib/context'
import { chequearFlujoFaltante } from '../completeness/_flujos'

export const noAccountDeletionTienda = defineCheck({
  id: 'sto.no_account_deletion',
  pillar: 'store_hygiene',
  name: 'store-no-account-deletion',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    return chequearFlujoFaltante(ctx, {
      catalogId: 'sto.no_account_deletion',
      taskId: 'delete_account',
      pantallaEsperada: /(cuenta|account|ajustes|settings|configuracion|configuración|perfil|profile)\/.*\.(tsx|jsx|vue|svelte)$/i,
      senalEnCodigo: /\b(?:auth\.admin\.deleteUser|deleteUser\s*\(|delete[-_ ]?account|eliminar[-_ ]?cuenta|borrar[-_ ]?cuenta)\b/i,
      leyenda: 'Recorrimos la app entera buscando la opción de eliminar la cuenta, que es la que va a buscar quien revise tu app en la tienda.',
    })
  },
})

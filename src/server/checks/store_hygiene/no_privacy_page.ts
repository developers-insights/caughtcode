/**
 * No hay página de privacidad.
 *
 * Se busca en el código, en el pie y en la app desplegada antes de afirmarlo.
 * Ver `_legales.ts` para por qué los tres lugares importan.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom } from '../lib/context'
import { buscarPaginaLegal, PRIVACIDAD } from './_legales'

export const noPrivacyPage = defineCheck({
  id: 'sto.no_privacy_page',
  pillar: 'store_hygiene',
  name: 'no-privacy-page',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const resultado = await buscarPaginaLegal(ctx, PRIVACIDAD)
    if (resultado.encontrada) return []
    if (resultado.evidence.length === 0) return [] // no pudimos mirar: no se afirma nada

    ctx.log('sto.no_privacy_page: no hay página de privacidad en el código, el pie ni la app.')
    return [draftFrom('sto.no_privacy_page', {}, resultado.evidence)]
  },
})

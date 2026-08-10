/**
 * No hay términos y condiciones.
 *
 * Misma búsqueda en tres lugares que la página de privacidad.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom } from '../lib/context'
import { buscarPaginaLegal, TERMINOS } from './_legales'

export const noTermsPage = defineCheck({
  id: 'sto.no_terms_page',
  pillar: 'store_hygiene',
  name: 'no-terms-page',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const resultado = await buscarPaginaLegal(ctx, TERMINOS)
    if (resultado.encontrada) return []
    if (resultado.evidence.length === 0) return []

    ctx.log('sto.no_terms_page: no hay términos y condiciones en el código, el pie ni la app.')
    return [draftFrom('sto.no_terms_page', {}, resultado.evidence)]
  },
})

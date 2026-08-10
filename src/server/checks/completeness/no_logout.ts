/**
 * No se puede cerrar sesión.
 *
 * El agente entra con una cuenta y busca la salida. Solo `not_found` cuenta.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck } from '../lib/context'
import { chequearFlujoFaltante } from './_flujos'

export const noLogout = defineCheck({
  id: 'cmp.no_logout',
  pillar: 'completeness',
  name: 'no-logout',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    return chequearFlujoFaltante(ctx, {
      catalogId: 'cmp.no_logout',
      taskId: 'logout',
      pantallaEsperada: /(header|navbar|nav|topbar|sidebar|menu|shell|layout)[^/]*\.(tsx|jsx|vue|svelte)$/i,
      senalEnCodigo: /\b(?:signOut\s*\(|sign[-_ ]?out|logout|log[-_ ]?out|cerrar[-_ ]?sesi[oó]n)\b/i,
      leyenda: 'Entramos con una cuenta y recorrimos el menú buscando la opción de salir: no aparece por ningún lado.',
    })
  },
})

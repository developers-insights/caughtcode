/**
 * En el celular la pantalla se sale para el costado.
 *
 * Medición, no impresión: `scrollWidth > clientWidth` con la ventana en 375 px.
 * Es un número contra otro número, y por eso entra en este pilar y no cae bajo
 * la prohibición de criticar diseño (D6): acá no se opina sobre cómo se ve, se
 * informa que hay contenido que no entra.
 *
 * El margen de 4 px evita reportar diferencias de redondeo del navegador.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaGrabacion, evidenciaNavegador } from '../lib/context'
import type { DesbordeObservado } from '../agent-input'

/** Debajo de esto es redondeo del navegador, no contenido que se sale. */
const TOLERANCIA_PX = 4

/** Solo se mide en pantalla de celular: es donde importa. */
const ANCHO_CELULAR = 500

export const horizontalOverflow = defineCheck({
  id: 'cmp.horizontal_overflow',
  pillar: 'completeness',
  name: 'horizontal-overflow',
  requires: ['deployed_app', 'browser_run'],
  async run(ctx): Promise<FindingDraft[]> {
    const mediciones = ctx.agent?.overflow ?? []
    const drafts: FindingDraft[] = []
    const vistas = new Set<string>()

    for (const medicion of mediciones) {
      if (medicion.viewportWidth > ANCHO_CELULAR) continue
      if (medicion.scrollWidth - medicion.clientWidth <= TOLERANCIA_PX) continue
      if (vistas.has(medicion.path)) continue
      vistas.add(medicion.path)

      drafts.push(
        draftFrom('cmp.horizontal_overflow', { ruta: medicion.path }, evidenciaDe(medicion)),
      )
      ctx.log(
        `cmp.horizontal_overflow: ${medicion.path} mide ${medicion.scrollWidth}px de ancho en una ventana de ${medicion.clientWidth}px.`,
      )
    }

    return drafts
  },
})

function evidenciaDe(medicion: DesbordeObservado): Evidence[] {
  const exceso = medicion.scrollWidth - medicion.clientWidth
  const culpable = medicion.culpable
    ? ` El elemento que se sale es "${medicion.culpable}".`
    : ''

  const evidence: Evidence[] = [
    evidenciaNavegador(
      medicion.url,
      `Con la ventana en ${medicion.viewportWidth} píxeles de ancho, el contenido ocupa ${medicion.scrollWidth}: ` +
        `se sale ${exceso} píxeles y la página se puede arrastrar para la derecha.${culpable}`,
      medicion.screenshotPath,
    ),
  ]

  evidence.push(
    evidenciaGrabacion(
      medicion.sessionId,
      Math.max(0, medicion.atMs - 500),
      medicion.atMs + 2500,
      'Acá se ve la pantalla arrastrándose para el costado en el celular.',
    ),
  )

  return evidence
}

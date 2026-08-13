/**
 * El flujo principal se traba.
 *
 * El hallazgo más caro del pilar: es el camino por el que llega el dinero. La
 * evidencia es la grabación del intento, recortada al paso exacto donde se
 * trabó — no al principio de la sesión, que serían treinta segundos de nada
 * antes de lo importante.
 *
 * `not_found` no cuenta acá: significa que el agente no encontró el flujo, no
 * que esté roto. Eso es otro hallazgo.
 */

import type { AgentSessionResult, Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaGrabacion, evidenciaNavegador, recortar } from '../lib/context'
import { idDeSesion } from '../agent-input'

export const flowBlocked = defineCheck({
  id: 'cmp.flow_blocked',
  pillar: 'completeness',
  name: 'flow-blocked',
  requires: ['deployed_app', 'browser_run'],
  async run(ctx): Promise<FindingDraft[]> {
    const sesiones = ctx.agent?.sessions ?? []
    const drafts: FindingDraft[] = []

    for (const sesion of sesiones) {
      if (sesion.taskId !== 'primary_flow') continue
      if (sesion.outcome !== 'blocked' && sesion.outcome !== 'error') continue

      const ultimo = sesion.steps[sesion.steps.length - 1]
      if (!ultimo) continue // sin pasos no hay nada que mostrar ni que contar

      const paso = describirPaso(sesion)
      const evidence: Evidence[] = [
        evidenciaGrabacion(
          idDeSesion(sesion),
          Math.max(0, ultimo.atMs - 6000),
          Math.min(sesion.durationMs, ultimo.atMs + 3000),
          `Acá se ve el momento exacto en el que nos trabamos: ${recortar(ultimo.note, 100)}`,
        ),
      ]

      if (ultimo.screenshotPath) {
        evidence.push(
          evidenciaNavegador(ultimo.url, recortar(ultimo.note, 200), ultimo.screenshotPath),
        )
      }

      ctx.log(`cmp.flow_blocked: se trabó en "${paso}".`)

      drafts.push(
        draftFrom(
          'cmp.flow_blocked',
          {
            flujo: sesion.conclusionPlain || 'el recorrido principal de tu app',
            paso,
            detalle: describirIntento(sesion),
          },
          evidence,
        ),
      )
    }

    return drafts
  },
})

/** El paso donde se trabó, en una frase. */
function describirPaso(sesion: AgentSessionResult): string {
  const ultimo = sesion.steps[sesion.steps.length - 1]
  if (!ultimo) return 'el primer paso'
  const destino = ultimo.target ? ` sobre "${ultimo.target}"` : ''
  return recortar(`${ultimo.action}${destino} en ${ultimo.url}`, 140)
}

/** Los últimos pasos, para que el prompt de arreglo tenga contexto real. */
function describirIntento(sesion: AgentSessionResult): string {
  return sesion.steps
    .slice(-5)
    .map((p, i) => `${i + 1}. ${p.action}${p.target ? ` sobre "${p.target}"` : ''} — ${p.note}`)
    .join('\n')
}

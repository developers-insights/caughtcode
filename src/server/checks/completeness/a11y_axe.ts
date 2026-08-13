/**
 * Problemas de accesibilidad medidos automáticamente.
 *
 * **Se reporta la cantidad, nunca un porcentaje de cumplimiento** (D8). La
 * razón: una revisión automática encuentra alrededor del 57% de los problemas
 * por volumen, pero solo el 30-40% de los criterios. Un "97% accesible" genera
 * exactamente la falsa confianza que este producto existe para evitar.
 *
 * El texto del catálogo ya lo dice ("esto es un piso, no un puntaje"), y acá se
 * respeta: se cuentan problemas y se listan, y no se calcula ninguna nota.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaNavegador } from '../lib/context'
import type { ProblemaAccesibilidad } from '../agent-input'

/** Los menores no entran: sumarían ruido sin cambiar ninguna decisión. */
const IMPACTO_MINIMO = new Set(['critical', 'serious', 'moderate'])

export const a11yAxe = defineCheck({
  id: 'cmp.a11y_axe',
  pillar: 'completeness',
  name: 'a11y-axe',
  requires: ['deployed_app', 'browser_run'],
  async run(ctx): Promise<FindingDraft[]> {
    const todos = ctx.agent?.a11y ?? []
    const problemas = todos.filter((p) => IMPACTO_MINIMO.has(p.impacto))
    if (problemas.length === 0) return []

    const pantallas = new Set(problemas.map((p) => p.path))
    const cantidad = problemas.reduce((suma, p) => suma + Math.max(1, p.cantidadElementos), 0)

    const agrupados = agrupar(problemas)
    const resumen = agrupados
      .slice(0, 3)
      .map((g) => `${g.descripcionPlain} (${g.total})`)
      .join(', ')

    const detalle = agrupados
      .map((g) => `${g.descripcionPlain}: ${g.total} en ${g.pantallas.join(', ')}`)
      .join('\n')

    const evidence: Evidence[] = agrupados.slice(0, 5).map((g) =>
      evidenciaNavegador(
        g.ejemplo.path,
        `${g.descripcionPlain}. Aparece ${g.total} ${g.total === 1 ? 'vez' : 'veces'}.`,
        g.ejemplo.screenshotPath,
      ),
    )

    ctx.log(`cmp.a11y_axe: ${cantidad} problemas en ${pantallas.size} pantallas.`)

    return [
      draftFrom(
        'cmp.a11y_axe',
        { cantidad, pantallas: pantallas.size, resumen, detalle },
        evidence,
      ),
    ]
  },
})

interface Grupo {
  descripcionPlain: string
  total: number
  pantallas: string[]
  ejemplo: ProblemaAccesibilidad
}

function agrupar(problemas: ProblemaAccesibilidad[]): Grupo[] {
  const porRegla = new Map<string, Grupo>()

  for (const problema of problemas) {
    const existente = porRegla.get(problema.ruleId)
    if (existente) {
      existente.total += Math.max(1, problema.cantidadElementos)
      if (!existente.pantallas.includes(problema.path)) existente.pantallas.push(problema.path)
      continue
    }
    porRegla.set(problema.ruleId, {
      descripcionPlain: problema.descripcionPlain,
      total: Math.max(1, problema.cantidadElementos),
      pantallas: [problema.path],
      ejemplo: problema,
    })
  }

  return [...porRegla.values()].sort((a, b) => b.total - a.total)
}

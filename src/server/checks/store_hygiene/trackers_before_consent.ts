/**
 * Se rastrea antes de pedir permiso.
 *
 * La infracción de consentimiento que más sanciones acumula en Europa, y la
 * única que se detecta con certeza desde afuera: se abre la app en un navegador
 * limpio y se mira qué sale a la red **antes** de tocar nada.
 *
 * `beforeConsent` lo determina el agente, no este chequeo: él es el que sabe en
 * qué momento se aceptó (o si nunca se aceptó nada). Acá solo se traduce.
 *
 * El texto del catálogo trae el encuadre obligatorio —"esto es lo que un
 * revisor o un regulador podría marcar"— y nunca dice que se viole ninguna ley
 * en particular (D7).
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaGrabacion, evidenciaNavegador } from '../lib/context'
import { enumerar, nombresDeTrackers, trackerDeHost } from '../trackers'

export const trackersBeforeConsent = defineCheck({
  id: 'sto.trackers_before_consent',
  pillar: 'store_hygiene',
  name: 'trackers-before-consent',
  requires: ['deployed_app', 'browser_run'],
  async run(ctx): Promise<FindingDraft[]> {
    const pedidos = (ctx.agent?.network ?? []).filter(
      (p) => p.beforeConsent && trackerDeHost(p.url) !== null,
    )
    const cookies = (ctx.agent?.cookies ?? []).filter((c) => c.beforeConsent)

    if (pedidos.length === 0) return []

    const nombres = nombresDeTrackers(pedidos.map((p) => p.url))
    if (nombres.length === 0) return []

    const evidence: Evidence[] = []

    // Un ejemplo concreto por servicio, no cien pedidos iguales.
    const porServicio = new Map<string, (typeof pedidos)[number]>()
    for (const pedido of pedidos) {
      const tracker = trackerDeHost(pedido.url)
      if (tracker && !porServicio.has(tracker.nombre)) porServicio.set(tracker.nombre, pedido)
    }

    for (const [nombre, pedido] of [...porServicio].slice(0, 5)) {
      evidence.push(
        evidenciaNavegador(
          pedido.url,
          `Al abrir ${pedido.fromPath}, y sin que nadie aceptara nada, tu app ya le mandó información a ${nombre}.`,
        ),
      )
    }

    if (cookies.length > 0) {
      const ejemplo = cookies[0]!
      evidence.push(
        evidenciaNavegador(
          ejemplo.fromPath,
          `También quedaron guardadas ${cookies.length} ${cookies.length === 1 ? 'cookie' : 'cookies'} antes de que la persona decidiera nada (por ejemplo "${ejemplo.name}").`,
        ),
      )
    }

    const primerPedido = pedidos[0]!
    evidence.push(
      evidenciaGrabacion(
        primerPedido.sessionId,
        0,
        Math.max(3000, primerPedido.atMs + 2000),
        'Navegador recién abierto, sin aceptar nada: acá se ven los pedidos saliendo solos.',
      ),
    )

    ctx.log(
      `sto.trackers_before_consent: ${pedidos.length} pedidos a ${nombres.length} servicios antes del consentimiento.`,
    )

    return [
      draftFrom(
        'sto.trackers_before_consent',
        { cantidad: pedidos.length, servicios: enumerar(nombres) },
        evidence,
      ),
    ]
  },
})

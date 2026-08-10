/**
 * Servicios externos que reciben datos y no están declarados.
 *
 * Se cruzan los servicios que aparecen en la red contra lo que dice la página
 * de privacidad. Si la página no existe, este hallazgo no se emite: ya lo dice
 * `sto.no_privacy_page`, y repetirlo sería contar dos veces el mismo problema.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaNavegador } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { unirUrl } from '../lib/http'
import { enumerar, trackerDeHost } from '../trackers'
import { PRIVACIDAD } from './_legales'

export const thirdPartyDataSharing = defineCheck({
  id: 'sto.third_party_data_sharing',
  pillar: 'store_hygiene',
  name: 'third-party-data-sharing',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const pedidos = ctx.agent?.network ?? []
    if (pedidos.length === 0) return []

    const textoPrivacidad = await leerPaginaPrivacidad(ctx)
    // Sin página de privacidad no hay nada contra qué cruzar.
    if (textoPrivacidad === null) return []

    const sinDeclarar = new Map<string, string>()
    for (const pedido of pedidos) {
      if (!pedido.thirdParty) continue
      const tracker = trackerDeHost(pedido.url)
      if (!tracker) continue
      if (mencionado(textoPrivacidad, tracker.nombre, tracker.hosts)) continue
      if (!sinDeclarar.has(tracker.nombre)) sinDeclarar.set(tracker.nombre, pedido.url)
    }

    if (sinDeclarar.size === 0) return []

    const nombres = [...sinDeclarar.keys()].sort((a, b) => a.localeCompare(b, 'es'))
    const evidence: Evidence[] = [...sinDeclarar]
      .slice(0, 5)
      .map(([nombre, url]) =>
        evidenciaNavegador(url, `Tu app le manda información a ${nombre} y tu página de privacidad no lo menciona.`),
      )

    ctx.log(`sto.third_party_data_sharing: ${nombres.length} servicios sin declarar.`)

    return [
      draftFrom(
        'sto.third_party_data_sharing',
        { cantidad: nombres.length, servicios: enumerar(nombres) },
        evidence,
      ),
    ]
  },
})

/** Devuelve el texto de la página de privacidad, o `null` si no existe. */
async function leerPaginaPrivacidad(ctx: CheckRunContext): Promise<string | null> {
  const enPaginas = (ctx.agent?.pages ?? []).find((p) =>
    PRIVACIDAD.rutas.includes(p.path.toLowerCase().replace(/\/$/, '')),
  )
  if (enPaginas?.html) return enPaginas.html.toLowerCase()

  const http = ctx.http
  const base = ctx.deployedUrl
  if (!http || !base) return null

  for (const ruta of PRIVACIDAD.rutas) {
    const respuesta = await http(unirUrl(base, ruta), { maxBytes: 64 * 1024 })
    if (respuesta && respuesta.status >= 200 && respuesta.status < 300) {
      return respuesta.body.toLowerCase()
    }
  }
  return null
}

/** El servicio está declarado si aparece su nombre o su dirección. */
function mencionado(texto: string, nombre: string, hosts: string[]): boolean {
  const nombreLimpio = nombre.toLowerCase().replace(/\s*\([^)]*\)\s*/g, '').trim()
  if (nombreLimpio.length >= 4 && texto.includes(nombreLimpio)) return true
  return hosts.some((host) => texto.includes(host.toLowerCase()))
}

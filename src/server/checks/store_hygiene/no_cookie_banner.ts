/**
 * Hay seguimiento y no hay aviso.
 *
 * Requiere las dos cosas: que existan servicios de seguimiento **y** que no
 * haya ningún aviso. Una app sin trackers no necesita banner, y decirle que sí
 * sería empujarla a poner un cartel que no hace falta.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaNavegador } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, coincidencias, esDePrueba } from '../lib/files'
import { enumerar, nombresDeTrackers, trackersEnTexto } from '../trackers'

/** Cualquier forma de aviso de consentimiento en el marcado servido. */
const HAY_AVISO =
  /(cookie[-\s]?banner|cookie[-\s]?consent|consent[-\s]?(?:banner|manager|mode)|aceptar\s+cookies|acepto\s+las\s+cookies|usamos\s+cookies|utilizamos\s+cookies|este\s+sitio\s+usa\s+cookies|gestionar\s+cookies|preferencias\s+de\s+cookies|cookiebot|cookieyes|osano|termly|onetrust|klaro|tarteaucitron|cookieconsent)/i

export const noCookieBanner = defineCheck({
  id: 'sto.no_cookie_banner',
  pillar: 'store_hygiene',
  name: 'no-cookie-banner',
  requires: ['deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const paginas = ctx.agent?.pages ?? []
    const pedidos = ctx.agent?.network ?? []

    const nombres = nombresDeTrackers(pedidos.map((p) => p.url))
    if (nombres.length === 0) return []

    // Si alguna pantalla mostró un aviso, no hay hallazgo.
    const conAviso = paginas.find((p) => p.html && HAY_AVISO.test(p.html))
    if (conAviso) return []

    // Tampoco si el aviso está en el código (puede no haberse mostrado todavía).
    const enCodigo = await avisoEnCodigo(ctx)
    if (enCodigo) return []

    if (paginas.length === 0) return [] // sin haber mirado ninguna pantalla no se afirma nada

    const evidence: Evidence[] = [
      evidenciaNavegador(
        paginas[0]!.url,
        `Abrimos tu app y revisamos la pantalla entera: no aparece ningún aviso sobre el seguimiento, ` +
          `y sin embargo se está usando ${enumerar(nombres)}.`,
        paginas[0]!.screenshotPath,
      ),
    ]

    ctx.log(`sto.no_cookie_banner: ${nombres.length} servicios sin ningún aviso.`)

    return [draftFrom('sto.no_cookie_banner', { servicios: enumerar(nombres) }, evidence)]
  },
})

async function avisoEnCodigo(ctx: CheckRunContext): Promise<Evidence | null> {
  const fuentes = await archivos(ctx)
  for (const archivo of fuentes) {
    if (esDePrueba(archivo.path)) continue
    const encontrado = [...coincidencias(archivo.text, HAY_AVISO)][0]
    if (encontrado) return evidenciaCodigo(archivo.path, encontrado.linea)
  }
  return null
}

/** Se exporta para que otros chequeos del pilar no repitan la lista. */
export { HAY_AVISO }

/** Servicios de seguimiento detectables leyendo el código, sin desplegar nada. */
export async function trackersEnElCodigo(ctx: CheckRunContext): Promise<string[]> {
  const fuentes = await archivos(ctx)
  const nombres = new Set<string>()
  for (const archivo of fuentes) {
    if (esDePrueba(archivo.path)) continue
    for (const tracker of trackersEnTexto(archivo.text)) nombres.add(tracker.nombre)
  }
  return [...nombres].sort((a, b) => a.localeCompare(b, 'es'))
}

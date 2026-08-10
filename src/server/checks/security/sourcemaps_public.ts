/**
 * Código original publicado.
 *
 * Se prueba, no se deduce: se baja la página, se sacan las referencias a
 * archivos de mapa, y se piden. Un 200 con un JSON que trae `sources` es la
 * prueba completa. Si el archivo no responde, no hay hallazgo.
 *
 * La configuración del proyecto (`productionBrowserSourceMaps: true`) sola no
 * alcanza: puede estar activada y el hosting no servirlos.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaHttp } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, coincidencias } from '../lib/files'
import { unirUrl } from '../lib/http'

const REFERENCIA_MAPA = /\/[/*]#\s*sourceMappingURL=([^\s*]+)/g
const SCRIPT_SRC = /<script[^>]+src=["']([^"']+\.js)["']/g
const MAX_INTENTOS = 6

export const sourcemapsPublic = defineCheck({
  id: 'sec.sourcemaps_public',
  pillar: 'security',
  name: 'sourcemaps-public',
  requires: ['deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const http = ctx.http
    const base = ctx.deployedUrl
    if (!http || !base) return []

    const portada = await http(base)
    if (!portada || portada.status >= 400) return []

    const candidatos = new Set<string>()

    // Mapas referenciados directo desde el HTML.
    for (const { match } of coincidencias(portada.body, REFERENCIA_MAPA)) {
      candidatos.add(unirUrl(portada.url, match[1]!))
    }

    // Y los que están al pie de cada bundle.
    for (const { match } of coincidencias(portada.body, SCRIPT_SRC)) {
      if (candidatos.size >= MAX_INTENTOS) break
      const urlScript = unirUrl(portada.url, match[1]!)
      const script = await http(urlScript, { maxBytes: 256 * 1024 })
      if (!script || script.status >= 400) continue

      const cola = script.body.slice(-2048)
      for (const { match: refe } of coincidencias(cola, REFERENCIA_MAPA)) {
        candidatos.add(unirUrl(urlScript, refe[1]!))
      }
      // Convención por defecto de casi todo empaquetador.
      candidatos.add(`${urlScript}.map`)
    }

    for (const url of [...candidatos].slice(0, MAX_INTENTOS)) {
      const mapa = await http(url, { maxBytes: 64 * 1024 })
      if (!mapa || mapa.status !== 200) continue
      if (!esMapaDeVerdad(mapa.body)) continue

      const evidence: Evidence[] = [
        evidenciaHttp(
          url,
          mapa.status,
          'Pedimos el archivo que reconstruye tu código original y el servidor lo entregó.',
        ),
      ]

      const config = await evidenciaDeConfiguracion(ctx)
      if (config) evidence.push(config)

      ctx.log(`sec.sourcemaps_public: ${url}`)
      return [draftFrom('sec.sourcemaps_public', { url }, evidence)]
    }

    return []
  },
})

/** Un `.map` de verdad es JSON con `sources`. Un 200 con la página de error, no. */
function esMapaDeVerdad(cuerpo: string): boolean {
  const inicio = cuerpo.trimStart().slice(0, 400)
  if (!inicio.startsWith('{')) return false
  return /"(?:sources|sourcesContent|mappings)"\s*:/.test(cuerpo.slice(0, 4096))
}

async function evidenciaDeConfiguracion(ctx: CheckRunContext): Promise<Evidence | null> {
  const fuentes = await archivos(ctx)
  const config = fuentes.find((a) => /^(next\.config|vite\.config)\.[jtm]s$/.test(a.path))
  if (!config) return null

  for (const { linea, lineaTexto } of coincidencias(
    config.text,
    /productionBrowserSourceMaps\s*:\s*true|sourcemap\s*:\s*true/g,
  )) {
    return evidenciaCodigo(config.path, linea, lineaTexto.trim())
  }
  return null
}

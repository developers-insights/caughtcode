/**
 * Enlaces internos que no llevan a ningún lado.
 *
 * Se cruzan los `href` del código contra las rutas reales del proyecto. Las
 * rutas con parámetro (`/proyectos/[id]`) se comparan por forma, no por texto:
 * `/proyectos/abc` coincide con `/proyectos/[id]` y no es un enlace roto.
 *
 * Un solo hallazgo con la cuenta total, no uno por enlace: veinte filas de lo
 * mismo es exactamente lo que hace que un reporte muera en una planilla (D15).
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaHttp, recortar } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, coincidencias, esCodigo, esDePrueba, esMarcado } from '../lib/files'
import { unirUrl } from '../lib/http'

const HREF = /\bhref\s*=\s*(?:["']([^"'{}]+)["']|\{\s*["']([^"']+)["']\s*\})/g

/** Direcciones que no son rutas de la app. */
const NO_ES_RUTA = /^(?:https?:|mailto:|tel:|#|javascript:|data:|\/\/|\.)/i

/** Archivos estáticos: viven en public/, no son rutas. */
const ES_ARCHIVO = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|txt|xml|json|css|js|zip|mp4|webm|woff2?)$/i

const MAX_VERIFICACIONES_HTTP = 8

export const brokenLinks = defineCheck({
  id: 'cmp.broken_links',
  pillar: 'completeness',
  name: 'broken-links',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const conocidas = rutasConocidas(ctx)
    if (conocidas.length === 0) return []

    const publicos = new Set(
      fuentes
        .filter((a) => /^(public|static)\//.test(a.path))
        .map((a) => `/${a.path.replace(/^(public|static)\//, '')}`),
    )

    interface Roto {
      href: string
      file: string
      linea: number
      lineaTexto: string
    }
    const rotos: Roto[] = []
    const vistos = new Set<string>()

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!esCodigo(archivo.path) && !esMarcado(archivo.path)) continue

      for (const { match, linea, lineaTexto } of coincidencias(archivo.text, HREF)) {
        const href = (match[1] ?? match[2] ?? '').trim()
        if (href === '' || NO_ES_RUTA.test(href)) continue
        if (!href.startsWith('/')) continue

        const limpio = href.split('?')[0]!.split('#')[0]!.replace(/\/$/, '') || '/'
        if (ES_ARCHIVO.test(limpio)) {
          if (publicos.has(limpio)) continue
          // Un archivo que no está en el proyecto puede venir del hosting.
          continue
        }
        if (vistos.has(limpio)) continue
        if (coincideConAlguna(limpio, conocidas)) continue

        vistos.add(limpio)
        rotos.push({ href: limpio, file: archivo.path, linea, lineaTexto })
      }
    }

    if (rotos.length === 0) return []

    // Verificación contra la app desplegada, si la hay.
    const confirmados: Evidence[] = []
    const http = ctx.http
    const base = ctx.deployedUrl
    if (http && base) {
      for (const roto of rotos.slice(0, MAX_VERIFICACIONES_HTTP)) {
        const url = unirUrl(base, roto.href)
        const respuesta = await http(url, { maxBytes: 2048 })
        if (respuesta && respuesta.status === 404) {
          confirmados.push(
            evidenciaHttp(url, respuesta.status, 'Abrimos este enlace y no existe.'),
          )
        }
      }
    }

    const evidence: Evidence[] = [
      ...rotos
        .slice(0, 5)
        .map((r) => evidenciaCodigo(r.file, r.linea, recortar(r.lineaTexto.trim()))),
      ...confirmados,
    ]

    const primero = rotos[0]!
    ctx.log(`cmp.broken_links: ${rotos.length} enlaces sin destino.`)

    return [
      draftFrom(
        'cmp.broken_links',
        {
          cantidad: rotos.length,
          ejemplo: primero.href,
          archivo: primero.file,
          detalle: rotos
            .slice(0, 10)
            .map((r) => `${r.href} (desde ${r.file}, línea ${r.linea})`)
            .join('; '),
        },
        evidence,
        { confidence: confirmados.length > 0 ? 'confirmed' : 'likely' },
      ),
    ]
  },
})

function rutasConocidas(ctx: CheckRunContext): string[] {
  return ctx.index.routes
    .filter((r) => r.kind === 'page' || r.kind === 'screen')
    .map((r) => r.path.replace(/\/$/, '') || '/')
}

/** `/proyectos/abc` contra `/proyectos/[id]`: se comparan segmento a segmento. */
function coincideConAlguna(href: string, rutas: string[]): boolean {
  const partesHref = href.split('/').filter(Boolean)

  return rutas.some((ruta) => {
    const partesRuta = ruta.split('/').filter(Boolean)

    // Un comodín se come el resto del camino.
    const comodin = partesRuta.findIndex((p) => /^\[\.\.\./.test(p))
    if (comodin >= 0) {
      return (
        partesHref.length >= comodin &&
        partesRuta
          .slice(0, comodin)
          .every((p, i) => coincideSegmento(p, partesHref[i]))
      )
    }

    if (partesRuta.length !== partesHref.length) return false
    return partesRuta.every((p, i) => coincideSegmento(p, partesHref[i]))
  })
}

function coincideSegmento(segmentoRuta: string, segmentoHref: string | undefined): boolean {
  if (segmentoHref === undefined) return false
  if (/^\[.+\]$/.test(segmentoRuta)) return true
  return segmentoRuta.toLowerCase() === segmentoHref.toLowerCase()
}

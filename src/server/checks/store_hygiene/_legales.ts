/**
 * Búsqueda de páginas legales: la parte compartida entre privacidad y términos.
 *
 * Se busca en tres lugares, porque con uno solo se falla:
 *   1. las rutas del proyecto (la página existe en el código)
 *   2. los enlaces del pie (existe pero apunta afuera, a Notion o a un PDF)
 *   3. la app desplegada (existe y no está en el código que nos dieron)
 *
 * Si aparece en cualquiera de los tres, no hay hallazgo. Decirle a alguien "no
 * tenés política de privacidad" cuando la tiene en Notion es el tipo de error
 * que arruina la confianza en todo el reporte.
 *
 * **Nunca se dictamina sobre legalidad** (D7): se dice qué podría marcar un
 * revisor de tienda, y el disclaimer va en el texto del catálogo.
 */

import type { Evidence } from '@/lib/types/domain'
import { evidenciaCodigo, evidenciaHttp } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, esDePrueba } from '../lib/files'
import { unirUrl } from '../lib/http'

export interface BusquedaLegal {
  /** Rutas candidatas a probar contra la app desplegada. */
  rutas: string[]
  /** Nombres de archivo o carpeta que delatan la página en el código. */
  enCodigo: RegExp
  /** Texto del enlace en el pie. */
  enEnlace: RegExp
}

export const PRIVACIDAD: BusquedaLegal = {
  rutas: ['/privacidad', '/privacy', '/politica-de-privacidad', '/privacy-policy', '/legal/privacidad', '/legal/privacy'],
  enCodigo: /(privacidad|privacy)[^/]*\/(page|index)\.[jt]sx?$|(privacidad|privacy|privacy-policy)\.(tsx|jsx|md|mdx|html)$/i,
  enEnlace: /(pol[ií]tica\s+de\s+privacidad|privacidad|privacy\s+policy|privacy)/i,
}

export const TERMINOS: BusquedaLegal = {
  rutas: ['/terminos', '/terms', '/terminos-y-condiciones', '/terms-of-service', '/tos', '/condiciones', '/legal/terminos', '/legal/terms'],
  enCodigo: /(terminos|términos|terms|tos|condiciones)[^/]*\/(page|index)\.[jt]sx?$|(terminos|términos|terms|condiciones)\.(tsx|jsx|md|mdx|html)$/i,
  enEnlace: /(t[eé]rminos\s+y\s+condiciones|t[eé]rminos|condiciones\s+de\s+uso|terms\s+(?:of\s+service|and\s+conditions)|terms)/i,
}

export interface ResultadoBusqueda {
  encontrada: boolean
  /** Dónde se la encontró, o qué se miró si no está. */
  evidence: Evidence[]
}

export async function buscarPaginaLegal(
  ctx: CheckRunContext,
  busqueda: BusquedaLegal,
): Promise<ResultadoBusqueda> {
  const fuentes = await archivos(ctx)

  // ── 1. Está en el código ────────────────────────────────────────────
  const enArchivos = fuentes.find((a) => !esDePrueba(a.path) && busqueda.enCodigo.test(a.path))
  if (enArchivos) return { encontrada: true, evidence: [] }

  const enRutas = ctx.index.routes.find((r) =>
    busqueda.rutas.some((ruta) => r.path.toLowerCase().replace(/\/$/, '') === ruta),
  )
  if (enRutas) return { encontrada: true, evidence: [] }

  // ── 2. Hay un enlace en el pie (puede apuntar afuera) ───────────────
  const pie = fuentes.filter(
    (a) => !esDePrueba(a.path) && /(footer|pie|layout)[^/]*\.[jt]sx$/i.test(a.path),
  )
  for (const archivo of pie) {
    if (busqueda.enEnlace.test(archivo.text)) return { encontrada: true, evidence: [] }
  }

  // ── 3. Responde en la app desplegada ────────────────────────────────
  const http = ctx.http
  const base = ctx.deployedUrl
  const probadas: string[] = []

  if (http && base) {
    for (const ruta of busqueda.rutas) {
      const url = unirUrl(base, ruta)
      const respuesta = await http(url, { maxBytes: 8192 })
      probadas.push(ruta)
      if (respuesta && respuesta.status >= 200 && respuesta.status < 300) {
        return { encontrada: true, evidence: [] }
      }
    }
  }

  // No está en ningún lado: la evidencia es dónde buscamos.
  const evidence: Evidence[] = []

  const referencia = pie[0] ?? fuentes.find((a) => /^(src\/)?app\/layout\.[jt]sx?$/.test(a.path))
  if (referencia) {
    evidence.push(
      evidenciaCodigo(
        referencia.path,
        1,
        'Miramos el pie de página y no hay enlace a esta página.',
      ),
    )
  }

  if (http && base && probadas.length > 0) {
    evidence.push(
      evidenciaHttp(
        unirUrl(base, probadas[0]!),
        404,
        `Probamos las direcciones habituales (${probadas.join(', ')}) y ninguna existe.`,
      ),
    )
  }

  return { encontrada: false, evidence }
}

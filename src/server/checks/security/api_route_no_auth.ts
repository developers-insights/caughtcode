/**
 * Dirección que trabaja con datos sin preguntar quién es quien pide.
 *
 * Confianza `likely` a propósito y por diseño del catálogo: la sesión se puede
 * estar verificando en un `proxy.ts`, en un envoltorio propio o en la propia
 * regla de acceso de la base. Decir "comprobado" acá sería mentir. Cuando hay
 * app desplegada se intenta confirmar con un pedido sin credenciales, y recién
 * ahí el hallazgo sube a comprobado.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaHttp, recortar } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, coincidencias, esDePrueba } from '../lib/files'
import { unirUrl } from '../lib/http'

/** Toca datos: cliente de base, ORM o SQL directo. */
const TOCA_DATOS =
  /\b(?:supabase|db|prisma|drizzle|pool|client)\s*\.\s*(?:from|query|execute|rpc|insert|update|delete|select|\$queryRaw|\$executeRaw)\b|\bcreateClient\s*\(/

/** Verifica identidad de alguna de las formas habituales. */
const VERIFICA_SESION =
  /\b(?:getUser|getClaims|getSession|auth\s*\(\s*\)|currentUser|requireUser|requireAuth|getServerSession|verifyToken|verifyJwt|withAuth|ensureAuthenticated|isAuthenticated|protectRoute|checkPermission|authorize)\b/

/** Handlers que exponen la ruta a internet. */
const HANDLER = /\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g

/** Rutas que son públicas a propósito y no tienen por qué pedir sesión. */
const PUBLICA_A_PROPOSITO =
  /(webhook|callback|health|status|ping|robots|sitemap|og|opengraph|revalidate|cron|auth\/|login|signup|register|sign-in|sign-up|reset|confirm|verify|stripe|checkout\/success)/i

export const apiRouteNoAuth = defineCheck({
  id: 'sec.api_route_no_auth',
  pillar: 'security',
  name: 'api-route-no-auth',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    // El proxy/middleware puede estar protegiendo todo: si existe y verifica
    // sesión, bajamos el ruido a las rutas que él no cubre.
    const proxy = fuentes.find((a) => /^(src\/)?(proxy|middleware)\.[jt]sx?$/.test(a.path))
    const proxyProtege = proxy ? VERIFICA_SESION.test(proxy.text) : false

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!/(^|\/)route\.[jt]sx?$/.test(archivo.path) && !/(^|\/)pages\/api\//.test(archivo.path)) {
        continue
      }
      if (PUBLICA_A_PROPOSITO.test(archivo.path)) continue
      if (!TOCA_DATOS.test(archivo.text)) continue
      if (VERIFICA_SESION.test(archivo.text)) continue

      const ruta = rutaDeArchivo(ctx, archivo.path)
      const metodos = [...coincidencias(archivo.text, HANDLER)]
      if (metodos.length === 0) continue

      const primero = metodos[0]!
      const evidence: Evidence[] = [
        evidenciaCodigo(
          archivo.path,
          primero.linea,
          recortar(primero.lineaTexto.trim()),
        ),
      ]

      let confianza: 'confirmed' | 'likely' = 'likely'

      const confirmacion = await confirmarSinCredenciales(ctx, ruta)
      if (confirmacion) {
        evidence.push(confirmacion)
        confianza = 'confirmed'
      }

      drafts.push(
        draftFrom(
          'sec.api_route_no_auth',
          { ruta, archivo: archivo.path, linea: primero.linea },
          evidence,
          { confidence: proxyProtege && confianza === 'likely' ? 'to_review' : confianza },
        ),
      )
      ctx.log(`sec.api_route_no_auth: ${ruta} (${archivo.path}:${primero.linea})`)
    }

    return drafts
  },
})

function rutaDeArchivo(ctx: CheckRunContext, file: string): string {
  const conocida = ctx.index.routes.find((r) => r.file === file)
  if (conocida) return conocida.path

  return `/${file
    .replace(/^(src\/)?(app|pages)\//, '')
    .replace(/\/route\.[jt]sx?$/, '')
    .replace(/\.[jt]sx?$/, '')
    .replace(/\/\([^)]*\)/g, '')}`
}

/**
 * Un GET sin ninguna credencial. Si devuelve 200 con cuerpo, la dirección
 * responde a cualquiera: eso ya no es una sospecha, es un hecho.
 */
async function confirmarSinCredenciales(
  ctx: CheckRunContext,
  ruta: string,
): Promise<Evidence | null> {
  const http = ctx.http
  const base = ctx.deployedUrl
  if (!http || !base) return null
  if (ruta.includes('[')) return null // ruta con parámetro: no sabemos qué valor poner

  const url = unirUrl(base, ruta)
  const respuesta = await http(url, { method: 'GET', maxBytes: 8192 })
  if (!respuesta) return null
  if (respuesta.status !== 200) return null
  if (respuesta.body.trim().length === 0) return null

  return evidenciaHttp(
    url,
    respuesta.status,
    'Le pedimos datos sin iniciar sesión y respondió con contenido.',
  )
}

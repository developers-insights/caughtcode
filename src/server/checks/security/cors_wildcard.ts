/**
 * Cualquier sitio puede pedirle datos a la app.
 *
 * Un `*` en la cabecera solo importa si esa dirección devuelve algo que dependa
 * de quién pregunta. Una ruta pública con `*` es correcta y frecuente: así se
 * sirve un feed o un catálogo abierto. Por eso se pide además que la ruta
 * trabaje con sesión o con datos.
 *
 * La prueba fuerte es la respuesta real de la app desplegada: la cabecera que
 * el servidor manda de verdad, no la que dice el código.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaHttp, recortar } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, coincidencias, esDePrueba } from '../lib/files'
import { unirUrl } from '../lib/http'

const CABECERA_ABIERTA =
  /['"]?Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|origin\s*:\s*['"]\*['"]/gi

const USA_SESION =
  /\b(?:getUser|getSession|getClaims|auth\s*\(|cookies\s*\(|credentials|Authorization|supabase\s*\.\s*from|prisma\s*\.|db\s*\.)/

export const corsWildcard = defineCheck({
  id: 'sec.cors_wildcard',
  pillar: 'security',
  name: 'cors-wildcard',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue

      const esRuta =
        /(^|\/)route\.[jt]sx?$/.test(archivo.path) ||
        /(^|\/)pages\/api\//.test(archivo.path) ||
        /^(src\/)?(proxy|middleware)\.[jt]sx?$/.test(archivo.path) ||
        /^next\.config\.[jtm]s$/.test(archivo.path)
      if (!esRuta) continue

      const coincidencia = [...coincidencias(archivo.text, CABECERA_ABIERTA)][0]
      if (!coincidencia) continue
      if (!USA_SESION.test(archivo.text)) continue

      const ruta = rutaDeArchivo(ctx, archivo.path)
      const evidence: Evidence[] = [
        evidenciaCodigo(archivo.path, coincidencia.linea, recortar(coincidencia.lineaTexto.trim())),
      ]

      const enVivo = await confirmarCabecera(ctx, ruta)
      if (enVivo) evidence.push(enVivo)

      drafts.push(
        draftFrom('sec.cors_wildcard', { ruta, archivo: archivo.path, linea: coincidencia.linea }, evidence, {
          confidence: enVivo ? 'confirmed' : 'likely',
        }),
      )
      ctx.log(`sec.cors_wildcard: ${ruta}`)
    }

    return drafts
  },
})

function rutaDeArchivo(ctx: CheckRunContext, file: string): string {
  const conocida = ctx.index.routes.find((r) => r.file === file)
  if (conocida) return conocida.path
  if (/^next\.config/.test(file) || /(proxy|middleware)\./.test(file)) return '/'
  return `/${file
    .replace(/^(src\/)?(app|pages)\//, '')
    .replace(/\/route\.[jt]sx?$/, '')
    .replace(/\.[jt]sx?$/, '')}`
}

async function confirmarCabecera(
  ctx: CheckRunContext,
  ruta: string,
): Promise<Evidence | null> {
  const http = ctx.http
  const base = ctx.deployedUrl
  if (!http || !base) return null
  if (ruta.includes('[')) return null

  const url = unirUrl(base, ruta)
  const respuesta = await http(url, { method: 'GET', maxBytes: 2048 })
  if (!respuesta) return null
  if (respuesta.headers['access-control-allow-origin'] !== '*') return null

  return evidenciaHttp(
    url,
    respuesta.status,
    'El servidor respondió avisando que cualquier página de internet puede hablarle.',
  )
}

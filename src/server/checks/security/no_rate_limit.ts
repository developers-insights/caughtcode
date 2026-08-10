/**
 * Sin tope de intentos en las direcciones sensibles.
 *
 * Confianza `to_review` por decisión del catálogo, y está bien que así sea: el
 * tope puede venir del hosting, de Supabase Auth o de un firewall que no se ve
 * en el código. Este chequeo dice "mirá esto", no "está roto". Es el ejemplo de
 * hallazgo donde inflar la confianza destruiría la del resto.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, coincidencias, esDePrueba } from '../lib/files'

/** Direcciones donde probar sin límite tiene consecuencias caras. */
const RUTA_SENSIBLE =
  /(login|signin|sign-in|iniciar-sesion|signup|sign-up|register|registro|reset|recuperar|forgot|olvide|verify|verificar|otp|magic-?link|contact|contacto|send|enviar|invite|invitar|subscribe|checkout|password)/i

/** Cualquier señal de que hay un tope aplicado. */
const HAY_TOPE =
  /\b(?:rateLimit|rate_limit|ratelimit|Ratelimit|RateLimiter|limiter|throttle|slowDown|upstash|@vercel\/firewall|checkRateLimit|tooManyRequests|429|arcjet|bottleneck|express-rate-limit|next-rate-limit)\b/i

export const noRateLimit = defineCheck({
  id: 'sec.no_rate_limit',
  pillar: 'security',
  name: 'no-rate-limit',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)

    // Un tope global en el proxy cubre todo: si está, no hay nada que decir.
    const proxy = fuentes.find((a) => /^(src\/)?(proxy|middleware)\.[jt]sx?$/.test(a.path))
    if (proxy && HAY_TOPE.test(proxy.text)) {
      ctx.log('sec.no_rate_limit: hay un tope global en el proxy; no se reporta nada.')
      return []
    }

    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue

      const esManejador =
        /(^|\/)route\.[jt]sx?$/.test(archivo.path) || /(^|\/)pages\/api\//.test(archivo.path)
      const esAccion = /^\s*['"]use server['"]/.test(archivo.text)
      if (!esManejador && !esAccion) continue

      if (!RUTA_SENSIBLE.test(archivo.path)) continue
      if (HAY_TOPE.test(archivo.text)) continue

      const handler = [...coincidencias(
        archivo.text,
        /\bexport\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|GET|\w+)\b/g,
      )][0]
      if (!handler) continue

      const ruta = rutaDeArchivo(ctx, archivo.path)
      drafts.push(
        draftFrom(
          'sec.no_rate_limit',
          { ruta, archivo: archivo.path, linea: handler.linea },
          [
            evidenciaCodigo(
              archivo.path,
              handler.linea,
              recortar(handler.lineaTexto.trim()),
            ),
          ],
        ),
      )
      ctx.log(`sec.no_rate_limit: ${ruta}`)
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

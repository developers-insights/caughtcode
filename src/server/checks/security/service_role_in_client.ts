/**
 * La llave maestra de la base en código que llega al navegador.
 *
 * Es el hallazgo más grave del pilar y el más frecuente en apps hechas con IA:
 * el asistente escribe `createClient(url, SERVICE_ROLE)` porque así "funciona"
 * y las reglas de acceso dejan de existir.
 *
 * Tres señales, todas concluyentes por sí solas:
 *   1. un JWT que dice `"role":"service_role"` en un archivo que se publica
 *   2. una variable `NEXT_PUBLIC_…SERVICE_ROLE…` (el prefijo la empaqueta)
 *   3. `SUPABASE_SERVICE_ROLE_KEY` leída desde un archivo con `'use client'`
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, coincidencias, esDePrueba, llegaAlNavegador } from '../lib/files'
import { enmascararEnLinea, esJwtServiceRole } from '../lib/mask'
import { esArchivoDeEjemplo } from './_patrones'

const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const VAR_PUBLICA_SERVICE_ROLE = /\bNEXT_PUBLIC_[A-Z0-9_]*SERVICE_ROLE[A-Z0-9_]*\b/g
const REFERENCIA_SERVICE_ROLE =
  /\b(?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|serviceRoleKey|service_role_key)\b/g

export const serviceRoleInClient = defineCheck({
  id: 'sec.service_role_in_client',
  pillar: 'security',
  name: 'service-role-in-client',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []
    const vistos = new Set<string>()

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (esArchivoDeEjemplo(archivo.path)) continue

      const esEnv = /(^|\/)\.env/.test(archivo.path)
      const publico = llegaAlNavegador(archivo, ctx)

      // ── 1. Un JWT de service_role, esté donde esté, si el archivo se publica
      if (publico || esEnv) {
        for (const { match, linea, lineaTexto } of coincidencias(archivo.text, JWT)) {
          const token = match[0]
          if (!esJwtServiceRole(token)) continue

          const clave = `${archivo.path}:${linea}`
          if (vistos.has(clave)) continue
          vistos.add(clave)

          drafts.push(
            emitir(archivo.path, linea, enmascararEnLinea(lineaTexto, token), [
              evidenciaCodigo(
                archivo.path,
                linea,
                recortar(enmascararEnLinea(lineaTexto, token).trim()),
              ),
            ]),
          )
          ctx.log(`sec.service_role_in_client: llave de administrador en ${clave}`)
        }
      }

      // ── 2. Variable con prefijo público que nombra la llave maestra ─────
      for (const { linea, lineaTexto } of coincidencias(archivo.text, VAR_PUBLICA_SERVICE_ROLE)) {
        const clave = `${archivo.path}:${linea}`
        if (vistos.has(clave)) continue
        vistos.add(clave)

        drafts.push(
          emitir(archivo.path, linea, lineaTexto, [
            evidenciaCodigo(
              archivo.path,
              linea,
              recortar(lineaTexto.trim()),
            ),
          ]),
        )
        ctx.log(`sec.service_role_in_client: variable pública en ${clave}`)
      }

      // ── 3. La llave maestra leída desde un archivo que se publica ───────
      if (!publico || esEnv) continue

      for (const { linea, lineaTexto } of coincidencias(archivo.text, REFERENCIA_SERVICE_ROLE)) {
        const clave = `${archivo.path}:${linea}`
        if (vistos.has(clave)) continue
        vistos.add(clave)

        drafts.push(
          emitir(archivo.path, linea, lineaTexto, [
            evidenciaCodigo(archivo.path, linea, recortar(lineaTexto.trim())),
          ]),
        )
        ctx.log(`sec.service_role_in_client: referencia en archivo de navegador ${clave}`)
      }
    }

    return drafts
  },
})

function emitir(
  file: string,
  linea: number,
  _lineaTexto: string,
  evidence: Evidence[],
): FindingDraft {
  return draftFrom('sec.service_role_in_client', { archivo: file, linea }, evidence)
}

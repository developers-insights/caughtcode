/**
 * Clave secreta escrita en el código.
 *
 * **El valor nunca sale en claro.** Todo lo que entra en la evidencia pasa por
 * `enmascarar()`: el snippet, el detalle, todo. Un hallazgo que filtra el
 * secreto que denuncia lo publica en la base, en la pantalla y en el video.
 *
 * Dos vías de detección, en orden de confianza:
 *   1. patrón de proveedor conocido → certeza, el prefijo no admite otra lectura
 *   2. nombre de variable sensible + valor de alta entropía → probable
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import { archivos, esDePrueba, lineaEn, textoDeLinea } from '../lib/files'
import { enmascarar, enmascararEnLinea, esJwtAnon, esJwtServiceRole, pareceSecreto } from '../lib/mask'
import {
  buscarSecretos,
  esArchivoDeEjemplo,
  esValorDeRelleno,
  leerAsignacionesEnv,
  NOMBRES_SENSIBLES,
} from './_patrones'

/** Tope de hallazgos: cien claves filtradas son un hallazgo, no cien. */
const MAX_POR_PROVEEDOR = 3

function veredictoJwt(token: string): 'secreto' | 'publico' | 'desconocido' {
  if (esJwtServiceRole(token)) return 'secreto'
  if (esJwtAnon(token)) return 'publico'
  return 'desconocido'
}

export const secretInRepo = defineCheck({
  id: 'sec.secret_in_repo',
  pillar: 'security',
  name: 'secret-in-repo',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []
    const porProveedor = new Map<string, number>()
    const vistos = new Set<string>()

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (esArchivoDeEjemplo(archivo.path)) continue

      // ── 1. Patrones de proveedor ──────────────────────────────────────
      for (const hallado of buscarSecretos(archivo.text, veredictoJwt)) {
        const clave = `${hallado.proveedor}:${hallado.valor}`
        if (vistos.has(clave)) continue

        const cuenta = porProveedor.get(hallado.proveedor) ?? 0
        if (cuenta >= MAX_POR_PROVEEDOR) continue

        vistos.add(clave)
        porProveedor.set(hallado.proveedor, cuenta + 1)

        const linea = lineaEn(archivo.text, hallado.index)
        drafts.push(
          armar(archivo.path, linea, hallado.proveedor, hallado.valor, archivo.text),
        )
        ctx.log(`sec.secret_in_repo: ${hallado.proveedor} en ${archivo.path}:${linea}`)
      }

      // ── 2. Variables de entorno con valor de alta entropía ────────────
      if (!/(^|\/)\.env/.test(archivo.path)) continue

      for (const { clave, valor, linea } of leerAsignacionesEnv(archivo.text)) {
        if (!NOMBRES_SENSIBLES.test(clave)) continue
        if (esValorDeRelleno(valor)) continue
        if (!pareceSecreto(valor)) continue
        if (vistos.has(`env:${valor}`)) continue

        // Si ya lo agarró un patrón de proveedor, no se repite.
        if ([...vistos].some((v) => v.endsWith(`:${valor}`))) continue

        vistos.add(`env:${valor}`)
        drafts.push(
          armar(archivo.path, linea, 'el servicio al que pertenece', valor, archivo.text, clave),
        )
        ctx.log(`sec.secret_in_repo: variable ${clave} en ${archivo.path}:${linea}`)
      }
    }

    return drafts
  },
})

function armar(
  file: string,
  linea: number,
  proveedor: string,
  valor: string,
  texto: string,
  nombreVariable?: string,
): FindingDraft {
  const cruda = textoDeLinea(texto, linea)
  const segura = recortar(enmascararEnLinea(cruda, valor).trim())

  const evidence: Evidence[] = [evidenciaCodigo(file, linea, segura)]

  return draftFrom(
    'sec.secret_in_repo',
    {
      archivo: file,
      linea,
      proveedor,
      clave_enmascarada: enmascarar(valor),
      ...(nombreVariable ? { variable: nombreVariable } : {}),
    },
    evidence,
  )
}

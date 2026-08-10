/**
 * Flujos que faltan: la parte compartida.
 *
 * Los cuatro flujos faltantes (borrar cuenta, recuperar contraseña, cerrar
 * sesión, verificar correo) se detectan igual, y la regla es la misma para los
 * cuatro:
 *
 *   **Solo `not_found` cuenta.** `blocked` y `error` significan que el agente se
 *   trabó antes de llegar, no que el flujo no exista. Decirle a alguien "no
 *   tenés borrado de cuenta" porque nuestro agente se perdió en un menú es
 *   exactamente el falso positivo que hunde la credibilidad de todo el reporte
 *   (D14). Ante la duda, no se emite.
 *
 * La evidencia principal es **la grabación**, no el código: la ausencia de algo
 * no tiene `archivo:línea`. Lo que sí se agrega, cuando existe, es una
 * evidencia de apoyo que señala la pantalla donde la opción debería estar.
 */

import type { AgentTaskId, Evidence, FindingDraft } from '@/lib/types/domain'
import { draftFrom, evidenciaCodigo, evidenciaGrabacion } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { archivos, esDePrueba } from '../lib/files'
import { flujoNoEncontrado, idDeSesion, rangoDeSesion } from '../agent-input'

export interface DefinicionFlujo {
  catalogId: string
  taskId: AgentTaskId
  /** Archivos donde la opción debería vivir. Se citan como apoyo. */
  pantallaEsperada: RegExp
  /** Código relacionado con el flujo. Sirve para matizar el detalle. */
  senalEnCodigo: RegExp
  /** Qué se ve en la grabación, en una frase. */
  leyenda: string
}

export async function chequearFlujoFaltante(
  ctx: CheckRunContext,
  def: DefinicionFlujo,
): Promise<FindingDraft[]> {
  const sesion = flujoNoEncontrado(ctx.agent, def.taskId)
  if (!sesion) return []

  const { startMs, endMs } = rangoDeSesion(sesion)
  const evidence: Evidence[] = [
    evidenciaGrabacion(idDeSesion(sesion), startMs, endMs, def.leyenda),
  ]

  const apoyo = await evidenciaDePantalla(ctx, def)
  if (apoyo) evidence.push(apoyo)

  ctx.log(`${def.catalogId}: el agente buscó "${def.taskId}" y no lo encontró.`)
  return [draftFrom(def.catalogId, {}, evidence)]
}

/**
 * Señala la pantalla donde la opción debería estar. Si además hay código del
 * flujo pero la app no lo expone, se dice: es información distinta y útil.
 */
async function evidenciaDePantalla(
  ctx: CheckRunContext,
  def: DefinicionFlujo,
): Promise<Evidence | null> {
  const fuentes = await archivos(ctx)
  const pantalla = fuentes.find(
    (a) => !esDePrueba(a.path) && def.pantallaEsperada.test(a.path),
  )
  if (!pantalla) return null

  const conCodigo = fuentes.find(
    (a) => !esDePrueba(a.path) && def.senalEnCodigo.test(a.text),
  )

  const detalle = conCodigo
    ? `Esta es la pantalla donde la opción debería estar. Hay código relacionado en "${conCodigo.path}", pero desde la app no se llega.`
    : 'Esta es la pantalla donde la opción debería estar y no está.'

  return evidenciaCodigo(pantalla.path, 1, detalle)
}

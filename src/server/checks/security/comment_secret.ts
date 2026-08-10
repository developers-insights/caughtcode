/**
 * Notas del código visibles para cualquier visitante.
 *
 * **El escaneo de comentarios no se reimplementa acá.** Lo hace el frente de
 * comentarios, que ya resuelve lo difícil: distinguir un comentario de un
 * string que parece uno, calcular si el archivo llega al navegador, y decidir
 * qué es funcional y no se toca.
 *
 * Este chequeo solo traduce: toma los aciertos que son secretos y además se
 * publican, y los convierte en hallazgo.
 *
 * ── Dependencia ──────────────────────────────────────────────────────────
 * `scanProject(repoPath, { routes? }) => Promise<CommentScanResult>` desde
 * `@/server/comments`.
 *
 * El import es **dinámico** por dos motivos, los dos vigentes ahora que el
 * módulo ya existe: aísla una falla suya (que no puede voltear los otros treinta
 * y pico de chequeos), y evita levantar su cadena de dependencias en los tests
 * que no lo necesitan. El tipo se toma del módulo real, así que si cambia la
 * firma, esto deja de compilar en vez de fallar en producción.
 */

import type { CommentHit, CommentScanResult, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, recortar } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { enmascarar } from '../lib/mask'
import { buscarSecretos } from './_patrones'
import { esJwtAnon, esJwtServiceRole } from '../lib/mask'

const MAX_HALLAZGOS = 5

type ScanProject = typeof import('@/server/comments').scanProject

export const commentSecret = defineCheck({
  id: 'sec.comment_secret',
  pillar: 'security',
  name: 'comment-secret',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const scan = await cargarEscaner(ctx)
    if (!scan) return []

    let resultado: CommentScanResult
    try {
      resultado = await scan(ctx.repoPath, { routes: ctx.index.routes })
    } catch (error) {
      ctx.log(
        `sec.comment_secret: el escaneo de comentarios falló: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }

    const expuestos = resultado.hits.filter(
      (hit) => hit.risk === 'secret' && hit.reach === 'ships_to_browser',
    )

    return expuestos.slice(0, MAX_HALLAZGOS).map((hit) => {
      ctx.log(`sec.comment_secret: ${hit.file}:${hit.line}`)
      return draftFrom(
        'sec.comment_secret',
        {
          archivo: hit.file,
          linea: hit.line,
          que_contiene: describirContenido(hit),
        },
        [
          evidenciaCodigo(
            hit.file,
            hit.line,
            recortar(taparSecretos(hit.text)),
            hit.endLine !== hit.line ? hit.endLine : undefined,
          ),
        ],
      )
    })
  },
})

/**
 * Qué dice el comentario, en una frase y sin repetirlo.
 * Nunca se cita el texto crudo si adentro hay una clave.
 */
function describirContenido(hit: CommentHit): string {
  const secretos = buscarSecretos(hit.text, veredictoJwt)
  if (secretos.length > 0) {
    const proveedor = secretos[0]!.proveedor
    return `una clave de ${proveedor} (${enmascarar(secretos[0]!.valor)})`
  }
  if (hit.reason) return hit.reason
  return 'información que no debería ser pública'
}

function veredictoJwt(token: string): 'secreto' | 'publico' | 'desconocido' {
  if (esJwtServiceRole(token)) return 'secreto'
  if (esJwtAnon(token)) return 'publico'
  return 'desconocido'
}

/** Enmascara cualquier clave antes de que el texto entre en la evidencia. */
function taparSecretos(texto: string): string {
  let salida = texto
  for (const { valor } of buscarSecretos(texto, veredictoJwt)) {
    salida = salida.split(valor).join(enmascarar(valor))
  }
  return salida
}

async function cargarEscaner(ctx: CheckRunContext): Promise<ScanProject | null> {
  try {
    const modulo = await import('@/server/comments')
    if (typeof modulo.scanProject !== 'function') {
      ctx.log('sec.comment_secret: @/server/comments no expone scanProject; se saltea.')
      return null
    }
    return modulo.scanProject
  } catch (error) {
    ctx.log(
      `sec.comment_secret: no se pudo cargar el escaneo de comentarios; se saltea. ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/**
 * No hay pantalla propia para direcciones que no existen.
 *
 * Es una ausencia, y una ausencia no tiene `archivo:línea`. La evidencia
 * entonces es el archivo que **sí** está —la raíz de las rutas— señalando que
 * el vecino que debería acompañarlo no aparece. Es verificable: cualquiera
 * abre esa carpeta y lo comprueba.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaHttp } from '../lib/context'
import { archivos } from '../lib/files'
import { unirUrl } from '../lib/http'

const PANTALLA_404 =
  /(^|\/)(not-found|_not-found|404|\[\.\.\.not[_-]?found\])\.[jt]sx?$|(^|\/)pages\/404\.[jt]sx?$/

/** Raíz de las rutas: si no existe, el proyecto no es de los que revisamos así. */
const RAIZ = /^(src\/)?app\/layout\.[jt]sx?$|^(src\/)?pages\/_app\.[jt]sx?$/

export const no404Page = defineCheck({
  id: 'cmp.no_404_page',
  pillar: 'completeness',
  name: 'no-404-page',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)

    if (fuentes.some((a) => PANTALLA_404.test(a.path))) return []

    const raiz = fuentes.find((a) => RAIZ.test(a.path))
    if (!raiz) return [] // sin raíz de rutas no se puede afirmar nada

    const evidence: Evidence[] = [
      evidenciaCodigo(
        raiz.path,
        1,
        'En esta carpeta debería estar la pantalla para direcciones inexistentes y no está.',
      ),
    ]

    const enVivo = await confirmarEnVivo(ctx)
    if (enVivo) evidence.push(enVivo)

    ctx.log('cmp.no_404_page: no existe pantalla propia para direcciones inexistentes.')
    return [draftFrom('cmp.no_404_page', {}, evidence)]
  },
})

/** Se pide una dirección que seguro no existe y se mira qué contesta. */
async function confirmarEnVivo(
  ctx: Parameters<Parameters<typeof defineCheck>[0]['run']>[0],
): Promise<Evidence | null> {
  const http = ctx.http
  const base = ctx.deployedUrl
  if (!http || !base) return null

  const url = unirUrl(base, '/caughtcode-esta-direccion-no-existe-9f2c')
  const respuesta = await http(url, { maxBytes: 16 * 1024 })
  if (!respuesta || respuesta.status !== 404) return null

  return evidenciaHttp(
    url,
    respuesta.status,
    'Pedimos una dirección inventada y respondió con la pantalla de error genérica del sistema.',
  )
}

/**
 * Carpeta de archivos subidos marcada como pública.
 *
 * Se emite con lo que dice el esquema. Si además hay app desplegada, se intenta
 * confirmar pidiendo el listado público: una respuesta 200 sin credenciales es
 * la prueba de que cualquiera entra.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaBase, evidenciaHttp } from '../lib/context'
import { unirUrl } from '../lib/http'

export const publicBucket = defineCheck({
  id: 'sec.public_bucket',
  pillar: 'security',
  name: 'public-bucket',
  requires: ['database'],
  async run(ctx): Promise<FindingDraft[]> {
    const publicos = ctx.index.dbSchema.buckets.filter((b) => b.public)
    if (publicos.length === 0) return []

    const drafts: FindingDraft[] = []

    for (const bucket of publicos) {
      const evidence: Evidence[] = [
        evidenciaBase(
          `storage.${bucket.name}`,
          'La carpeta está marcada como pública: sus archivos se abren con la dirección directa, sin cuenta ni permiso.',
        ),
      ]

      const confirmacion = await confirmarPorHttp(ctx, bucket.name)
      if (confirmacion) evidence.push(confirmacion)

      drafts.push(draftFrom('sec.public_bucket', { bucket: bucket.name }, evidence))
    }

    return drafts
  },
})

/**
 * Pide el listado público de la carpeta sin credenciales. Es exactamente lo que
 * puede hacer cualquier persona con la dirección del proyecto.
 */
async function confirmarPorHttp(
  ctx: Parameters<Parameters<typeof defineCheck>[0]['run']>[0],
  bucket: string,
): Promise<Evidence | null> {
  const http = ctx.http
  const base = ctx.deployedUrl
  if (!http || !base) return null

  const url = unirUrl(base, `/storage/v1/object/public/${encodeURIComponent(bucket)}/`)
  const respuesta = await http(url, { method: 'GET', maxBytes: 4096 })
  if (!respuesta) return null
  if (respuesta.status >= 400) return null

  return evidenciaHttp(
    url,
    respuesta.status,
    'Pedimos un archivo de esa carpeta sin ninguna credencial y el servidor respondió.',
  )
}

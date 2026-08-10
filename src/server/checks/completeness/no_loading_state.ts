/**
 * Pantalla en blanco mientras carga.
 *
 * Se mira solo las pantallas que **esperan datos**: una pantalla estática no
 * tiene nada que mostrar mientras carga. Cuenta como resuelto cualquiera de las
 * tres formas: un `loading.tsx` al lado, un `<Suspense>`, o un estado propio.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo } from '../lib/context'
import { archivos, esDePrueba } from '../lib/files'

const ES_PANTALLA = /(^|\/)(page|index)\.[jt]sx$/

/** Espera datos: hay await de una fuente externa. */
const ESPERA_DATOS =
  /\bawait\s+(?:\w+\s*\.\s*)*(?:fetch|from|select|query|findMany|findFirst|findUnique|get|list|rpc|execute)\s*\(|\buse(?:Query|SWR|Fetch|Suspense\w*)\s*\(/

/** Alguna forma de avisar que está cargando. */
const MUESTRA_CARGA =
  /<Suspense\b|\b(?:isLoading|isPending|isFetching|loading|cargando|pending|Skeleton|Spinner|Shimmer|Placeholder)\b/i

export const noLoadingState = defineCheck({
  id: 'cmp.no_loading_state',
  pillar: 'completeness',
  name: 'no-loading-state',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const porRuta = new Set(fuentes.map((a) => a.path))
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (!ES_PANTALLA.test(archivo.path)) continue
      if (!ESPERA_DATOS.test(archivo.text)) continue
      if (MUESTRA_CARGA.test(archivo.text)) continue

      // ¿Hay un loading.tsx en la misma carpeta?
      const carpeta = archivo.path.slice(0, archivo.path.lastIndexOf('/'))
      const tieneLoading = ['loading.tsx', 'loading.jsx', 'loading.ts', 'loading.js'].some((n) =>
        porRuta.has(carpeta === '' ? n : `${carpeta}/${n}`),
      )
      if (tieneLoading) continue

      const ruta = rutaDeArchivo(ctx.index.routes, archivo.path)
      drafts.push(
        draftFrom(
          'cmp.no_loading_state',
          { ruta, archivo: archivo.path },
          [
            evidenciaCodigo(
              archivo.path,
              1,
              'Esta pantalla pide datos al servidor y no hay nada que mostrar mientras llegan: ni un archivo de carga al lado, ni un estado propio.',
            ),
          ],
        ),
      )
      ctx.log(`cmp.no_loading_state: ${ruta}`)
    }

    return drafts
  },
})

export function rutaDeArchivo(
  rutas: Array<{ file: string; path: string }>,
  file: string,
): string {
  const conocida = rutas.find((r) => r.file === file)
  if (conocida) return conocida.path
  const derivada = file
    .replace(/^(src\/)?(app|pages)\//, '')
    .replace(/\/(page|index|route)\.[jt]sx?$/, '')
    .replace(/\.[jt]sx?$/, '')
    .replace(/\/?\([^)]*\)/g, '')
  return derivada === '' ? '/' : `/${derivada.replace(/^\/+/, '')}`
}

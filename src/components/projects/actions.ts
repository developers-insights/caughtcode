'use server'

/**
 * Acciones compartidas de proyectos: las usan tanto la tarjeta de la lista
 * como la pantalla de ajustes de un proyecto puntual.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { B, F } from '@/lib/db/tablas'
import type { DeleteResult } from '@/lib/types/database'

export interface ActionResult {
  ok: boolean
  error?: string
}

/**
 * Borra el proyecto entero (`delete_project_cascade_caughtcode`) y los
 * objetos de Storage que queden huérfanos.
 *
 * Probamos a borrar el mismo path en los tres buckets: la función de base no
 * distingue de cuál viene cada uno (puede ser un zip, una grabación o un
 * video, escritos por frentes distintos), y borrar una ruta que no existe en
 * un bucket no da error. Es la forma segura de no dejar nada colgado.
 */
export async function deleteProjectAction(projectId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc(F.deleteProjectCascade, { p_project_id: projectId })

  if (error) {
    return { ok: false, error: 'No pudimos borrar el proyecto. Probá de nuevo en un minuto.' }
  }

  const storageObjects = (data as DeleteResult | null)?.storage_objects ?? []
  if (storageObjects.length > 0) {
    const admin = createAdminClient()
    await Promise.allSettled(
      [B.repos, B.recordings, B.videos].map((bucket) => admin.storage.from(bucket).remove(storageObjects)),
    )
  }

  return { ok: true }
}

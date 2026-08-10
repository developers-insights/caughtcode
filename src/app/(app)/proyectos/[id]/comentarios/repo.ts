import 'server-only'

/**
 * Quién puede ver este proyecto y dónde está su código.
 *
 * La descarga del repositorio del usuario todavía no existe: la trae el frente
 * de ingesta y deja el código en disco. Hasta entonces, en modo demostración
 * auditamos este mismo repositorio — que es código real, no inventado — y en
 * cualquier otro caso la pantalla muestra su estado de "todavía sin revisar".
 */

import { T } from '@/lib/db/tablas'
import { createClient } from '@/lib/supabase/server'
import { MODO_DEMO } from '@/app/(app)/demo'
import { DEMO_PROJECTS } from '@/components/projects/fixtures'

export type Acceso =
  | { estado: 'ok'; nombre: string; repoPath: string | null }
  | { estado: 'sin-acceso' }

/**
 * Resuelve el proyecto contra la base con la sesión de quien mira. Las reglas
 * de acceso de la base son las que deciden: si no es suyo, no vuelve nada.
 */
export async function resolverProyecto(projectId: string): Promise<Acceso> {
  // En demostración auditamos este mismo repositorio: código real, no fixtures.
  // El nombre sale de los proyectos de ejemplo para que las migas de pan
  // coincidan con el resto de la zona autenticada.
  if (MODO_DEMO) {
    const demo = DEMO_PROJECTS.find((p) => p.id === projectId)
    return { estado: 'ok', nombre: demo?.name ?? 'caughtcode', repoPath: process.cwd() }
  }

  try {
    const supabase = await createClient()
    const { data } = await supabase
      .from(T.projects)
      .select('name')
      .eq('id', projectId)
      .is('deleted_at', null)
      .maybeSingle()

    if (!data) return { estado: 'sin-acceso' }
    return { estado: 'ok', nombre: data.name, repoPath: null }
  } catch {
    return { estado: 'sin-acceso' }
  }
}

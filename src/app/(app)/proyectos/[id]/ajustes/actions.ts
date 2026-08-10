'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { T } from '@/lib/db/tablas'

export interface UpdateProjectInput {
  projectId: string
  name: string
  clientName: string
  deployedUrl: string
  retentionDays: number
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export async function updateProjectAction(input: UpdateProjectInput): Promise<ActionResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'El nombre no puede quedar vacío.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from(T.projects)
    .update({
      name,
      client_name: input.clientName.trim() || null,
      deployed_url: input.deployedUrl.trim() || null,
      retention_days: input.retentionDays,
    })
    .eq('id', input.projectId)

  if (error) {
    return { ok: false, error: 'No pudimos guardar los cambios. Probá de nuevo en un minuto.' }
  }

  revalidatePath(`/proyectos/${input.projectId}/ajustes`)
  revalidatePath('/proyectos')
  return { ok: true }
}

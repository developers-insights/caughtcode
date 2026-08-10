'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { B, F } from '@/lib/db/tablas'
import type { DeleteResult } from '@/lib/types/database'

export interface ActionResult {
  ok: boolean
  error?: string
}

export async function updateProfileAction(name: string): Promise<ActionResult> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Contanos cómo te llamás.' }

  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ data: { full_name: trimmed } })
  if (error) return { ok: false, error: 'No pudimos guardar el cambio. Probá de nuevo.' }

  return { ok: true }
}

/**
 * Borrado real de la cuenta. Orden importa:
 *  1. RPC (necesita la sesión viva: usa auth.uid() para confirmar que cada
 *     quien borra la suya).
 *  2. Objetos de Storage — probamos los tres buckets por la misma razón que
 *     en `src/components/projects/actions.ts`.
 *  3. `auth.admin.deleteUser()`: la fila de auth.users la administra GoTrue,
 *     no se toca desde SQL (y menos en una base compartida).
 *  4. Cerrar sesión: mejor esfuerzo, el usuario ya no existe.
 */
export async function deleteAccountAction(): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData?.user?.id

  if (!userId) {
    return { ok: false, error: 'No pudimos verificar tu sesión. Volvé a entrar e intentá de nuevo.' }
  }

  const { data, error } = await supabase.rpc(F.deleteAccount, { p_user_id: userId })
  if (error) {
    return { ok: false, error: 'No pudimos borrar tu cuenta. Probá de nuevo en un minuto.' }
  }

  const storageObjects = (data as DeleteResult | null)?.storage_objects ?? []
  const admin = createAdminClient()

  if (storageObjects.length > 0) {
    await Promise.allSettled(
      [B.repos, B.recordings, B.videos].map((bucket) => admin.storage.from(bucket).remove(storageObjects)),
    )
  }

  await admin.auth.admin.deleteUser(userId).catch(() => {
    /* la cuenta ya perdió sus datos; si esto falla, queda a mano en el panel de Supabase */
  })

  await supabase.auth.signOut().catch(() => {})

  redirect('/cuenta-borrada')
}
